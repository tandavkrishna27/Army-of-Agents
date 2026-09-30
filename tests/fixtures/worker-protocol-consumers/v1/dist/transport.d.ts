import { z } from "zod";
import { type ProtocolErrorCode } from "./errors.js";
import { type RuntimeDecisionRequestV1 } from "./events.js";
/** The closed set of operation authentication audiences. Each operation binds a
 * literal audience so a message presented to the wrong audience fails closed. */
export declare const AUTH_AUDIENCES: readonly ["target_enrollment", "worker_poll", "worker_run", "device_session", "control_channel"];
export declare const authAudienceSchema: z.ZodEnum<["target_enrollment", "worker_poll", "worker_run", "device_session", "control_channel"]>;
export type AuthAudience = (typeof AUTH_AUDIENCES)[number];
export declare const enrollmentRequestV1Schema: z.ZodEffects<z.ZodObject<{
    audience: z.ZodLiteral<"target_enrollment">;
    idempotencyKey: z.ZodString;
    hello: z.ZodEffects<z.ZodObject<{
        protocolVersion: z.ZodLiteral<1>;
        workerId: z.ZodBranded<z.ZodString, "WorkerId">;
        targetId: z.ZodBranded<z.ZodString, "TargetId">;
        deviceGeneration: z.ZodNumber;
        agentVersion: z.ZodString;
        supportedProtocol: z.ZodEffects<z.ZodObject<{
            min: z.ZodNumber;
            max: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            min: number;
            max: number;
        }, {
            min: number;
            max: number;
        }>, {
            min: number;
            max: number;
        }, {
            min: number;
            max: number;
        }>;
        platform: z.ZodObject<{
            os: z.ZodEnum<["linux", "darwin", "windows"]>;
            arch: z.ZodEnum<["x64", "arm64"]>;
            runtime: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            os: "linux" | "darwin" | "windows";
            arch: "x64" | "arm64";
            runtime: string;
        }, {
            os: "linux" | "darwin" | "windows";
            arch: "x64" | "arm64";
            runtime: string;
        }>;
        reportedCapabilities: z.ZodArray<z.ZodEnum<["workload.batch", "workload.browser_session", "workload.service", "provider.lifecycle_v1", "provider.cleanup_v1", "provider.checkpoint_v1", "provider.health_v1", "artifact.direct_upload", "secret.proxy", "sandbox.filesystem_isolated", "sandbox.process_isolated", "sandbox.filtered_egress"]>, "many">;
        capacity: z.ZodObject<{
            batchSlots: z.ZodNumber;
            browserSessionSlots: z.ZodNumber;
            serviceSlots: z.ZodNumber;
            freeCpuMillis: z.ZodNumber;
            freeMemoryMiB: z.ZodNumber;
            freeDiskMiB: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            batchSlots: number;
            browserSessionSlots: number;
            serviceSlots: number;
            freeCpuMillis: number;
            freeMemoryMiB: number;
            freeDiskMiB: number;
        }, {
            batchSlots: number;
            browserSessionSlots: number;
            serviceSlots: number;
            freeCpuMillis: number;
            freeMemoryMiB: number;
            freeDiskMiB: number;
        }>;
        policyHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
    }, "strict", z.ZodTypeAny, {
        platform: {
            os: "linux" | "darwin" | "windows";
            arch: "x64" | "arm64";
            runtime: string;
        };
        protocolVersion: 1;
        policyHash: string & z.BRAND<"Sha256Digest">;
        workerId: string & z.BRAND<"WorkerId">;
        targetId: string & z.BRAND<"TargetId">;
        deviceGeneration: number;
        agentVersion: string;
        supportedProtocol: {
            min: number;
            max: number;
        };
        reportedCapabilities: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
        capacity: {
            batchSlots: number;
            browserSessionSlots: number;
            serviceSlots: number;
            freeCpuMillis: number;
            freeMemoryMiB: number;
            freeDiskMiB: number;
        };
    }, {
        platform: {
            os: "linux" | "darwin" | "windows";
            arch: "x64" | "arm64";
            runtime: string;
        };
        protocolVersion: 1;
        policyHash: string;
        workerId: string;
        targetId: string;
        deviceGeneration: number;
        agentVersion: string;
        supportedProtocol: {
            min: number;
            max: number;
        };
        reportedCapabilities: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
        capacity: {
            batchSlots: number;
            browserSessionSlots: number;
            serviceSlots: number;
            freeCpuMillis: number;
            freeMemoryMiB: number;
            freeDiskMiB: number;
        };
    }>, {
        platform: {
            os: "linux" | "darwin" | "windows";
            arch: "x64" | "arm64";
            runtime: string;
        };
        protocolVersion: 1;
        policyHash: string & z.BRAND<"Sha256Digest">;
        workerId: string & z.BRAND<"WorkerId">;
        targetId: string & z.BRAND<"TargetId">;
        deviceGeneration: number;
        agentVersion: string;
        supportedProtocol: {
            min: number;
            max: number;
        };
        reportedCapabilities: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
        capacity: {
            batchSlots: number;
            browserSessionSlots: number;
            serviceSlots: number;
            freeCpuMillis: number;
            freeMemoryMiB: number;
            freeDiskMiB: number;
        };
    }, {
        platform: {
            os: "linux" | "darwin" | "windows";
            arch: "x64" | "arm64";
            runtime: string;
        };
        protocolVersion: 1;
        policyHash: string;
        workerId: string;
        targetId: string;
        deviceGeneration: number;
        agentVersion: string;
        supportedProtocol: {
            min: number;
            max: number;
        };
        reportedCapabilities: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
        capacity: {
            batchSlots: number;
            browserSessionSlots: number;
            serviceSlots: number;
            freeCpuMillis: number;
            freeMemoryMiB: number;
            freeDiskMiB: number;
        };
    }>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    issuedAt: z.ZodString;
    nonce: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "target_enrollment";
    idempotencyKey: string;
    hello: {
        platform: {
            os: "linux" | "darwin" | "windows";
            arch: "x64" | "arm64";
            runtime: string;
        };
        protocolVersion: 1;
        policyHash: string & z.BRAND<"Sha256Digest">;
        workerId: string & z.BRAND<"WorkerId">;
        targetId: string & z.BRAND<"TargetId">;
        deviceGeneration: number;
        agentVersion: string;
        supportedProtocol: {
            min: number;
            max: number;
        };
        reportedCapabilities: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
        capacity: {
            batchSlots: number;
            browserSessionSlots: number;
            serviceSlots: number;
            freeCpuMillis: number;
            freeMemoryMiB: number;
            freeDiskMiB: number;
        };
    };
}, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "target_enrollment";
    idempotencyKey: string;
    hello: {
        platform: {
            os: "linux" | "darwin" | "windows";
            arch: "x64" | "arm64";
            runtime: string;
        };
        protocolVersion: 1;
        policyHash: string;
        workerId: string;
        targetId: string;
        deviceGeneration: number;
        agentVersion: string;
        supportedProtocol: {
            min: number;
            max: number;
        };
        reportedCapabilities: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
        capacity: {
            batchSlots: number;
            browserSessionSlots: number;
            serviceSlots: number;
            freeCpuMillis: number;
            freeMemoryMiB: number;
            freeDiskMiB: number;
        };
    };
}>, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "target_enrollment";
    idempotencyKey: string;
    hello: {
        platform: {
            os: "linux" | "darwin" | "windows";
            arch: "x64" | "arm64";
            runtime: string;
        };
        protocolVersion: 1;
        policyHash: string & z.BRAND<"Sha256Digest">;
        workerId: string & z.BRAND<"WorkerId">;
        targetId: string & z.BRAND<"TargetId">;
        deviceGeneration: number;
        agentVersion: string;
        supportedProtocol: {
            min: number;
            max: number;
        };
        reportedCapabilities: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
        capacity: {
            batchSlots: number;
            browserSessionSlots: number;
            serviceSlots: number;
            freeCpuMillis: number;
            freeMemoryMiB: number;
            freeDiskMiB: number;
        };
    };
}, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "target_enrollment";
    idempotencyKey: string;
    hello: {
        platform: {
            os: "linux" | "darwin" | "windows";
            arch: "x64" | "arm64";
            runtime: string;
        };
        protocolVersion: 1;
        policyHash: string;
        workerId: string;
        targetId: string;
        deviceGeneration: number;
        agentVersion: string;
        supportedProtocol: {
            min: number;
            max: number;
        };
        reportedCapabilities: ("workload.batch" | "workload.browser_session" | "workload.service" | "provider.lifecycle_v1" | "provider.cleanup_v1" | "provider.checkpoint_v1" | "provider.health_v1" | "artifact.direct_upload" | "secret.proxy" | "sandbox.filesystem_isolated" | "sandbox.process_isolated" | "sandbox.filtered_egress")[];
        capacity: {
            batchSlots: number;
            browserSessionSlots: number;
            serviceSlots: number;
            freeCpuMillis: number;
            freeMemoryMiB: number;
            freeDiskMiB: number;
        };
    };
}>;
export type EnrollmentRequestV1 = z.infer<typeof enrollmentRequestV1Schema>;
export declare const enrollmentResponseV1Schema: z.ZodEffects<z.ZodDiscriminatedUnion<"outcome", [z.ZodObject<{
    outcome: z.ZodLiteral<"enrolled">;
    workerId: z.ZodBranded<z.ZodString, "WorkerId">;
    targetId: z.ZodBranded<z.ZodString, "TargetId">;
    deviceGeneration: z.ZodNumber;
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
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    serverTime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    providerConstraints: {
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
        profileId: string;
    };
    protocolVersion: 1;
    workerId: string & z.BRAND<"WorkerId">;
    targetId: string & z.BRAND<"TargetId">;
    deviceGeneration: number;
    correlationId: string;
    serverTime: string;
    outcome: "enrolled";
}, {
    providerConstraints: {
        version: number;
        digest: string;
        profileId: string;
    };
    protocolVersion: 1;
    workerId: string;
    targetId: string;
    deviceGeneration: number;
    correlationId: string;
    serverTime: string;
    outcome: "enrolled";
}>, z.ZodObject<{
    outcome: z.ZodLiteral<"rejected">;
    reason: z.ZodEnum<["malformed", "unauthorized", "incompatible_protocol", "incompatible_capability", "incompatible_policy", "stale_fence", "sequence_gap", "target_revoked", "event_hash_mismatch", "throttled", "payload_too_large", "attempt_terminal", "internal_unavailable"]>;
    retryAfterMs: z.ZodNullable<z.ZodNumber>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    serverTime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    retryAfterMs: number | null;
    serverTime: string;
    outcome: "rejected";
}, {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    retryAfterMs: number | null;
    serverTime: string;
    outcome: "rejected";
}>]>, {
    providerConstraints: {
        version: number;
        digest: string & z.BRAND<"Sha256Digest">;
        profileId: string;
    };
    protocolVersion: 1;
    workerId: string & z.BRAND<"WorkerId">;
    targetId: string & z.BRAND<"TargetId">;
    deviceGeneration: number;
    correlationId: string;
    serverTime: string;
    outcome: "enrolled";
} | {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    retryAfterMs: number | null;
    serverTime: string;
    outcome: "rejected";
}, {
    providerConstraints: {
        version: number;
        digest: string;
        profileId: string;
    };
    protocolVersion: 1;
    workerId: string;
    targetId: string;
    deviceGeneration: number;
    correlationId: string;
    serverTime: string;
    outcome: "enrolled";
} | {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    retryAfterMs: number | null;
    serverTime: string;
    outcome: "rejected";
}>;
export type EnrollmentResponseV1 = z.infer<typeof enrollmentResponseV1Schema>;
export declare const pollRequestV1Schema: z.ZodEffects<z.ZodObject<{
    audience: z.ZodLiteral<"worker_poll">;
    workerId: z.ZodBranded<z.ZodString, "WorkerId">;
    targetId: z.ZodBranded<z.ZodString, "TargetId">;
    deviceGeneration: z.ZodNumber;
    capacity: z.ZodObject<{
        batchSlots: z.ZodNumber;
        browserSessionSlots: z.ZodNumber;
        serviceSlots: z.ZodNumber;
        freeCpuMillis: z.ZodNumber;
        freeMemoryMiB: z.ZodNumber;
        freeDiskMiB: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        batchSlots: number;
        browserSessionSlots: number;
        serviceSlots: number;
        freeCpuMillis: number;
        freeMemoryMiB: number;
        freeDiskMiB: number;
    }, {
        batchSlots: number;
        browserSessionSlots: number;
        serviceSlots: number;
        freeCpuMillis: number;
        freeMemoryMiB: number;
        freeDiskMiB: number;
    }>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    issuedAt: z.ZodString;
    nonce: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    workerId: string & z.BRAND<"WorkerId">;
    issuedAt: string;
    targetId: string & z.BRAND<"TargetId">;
    deviceGeneration: number;
    nonce: string;
    capacity: {
        batchSlots: number;
        browserSessionSlots: number;
        serviceSlots: number;
        freeCpuMillis: number;
        freeMemoryMiB: number;
        freeDiskMiB: number;
    };
    correlationId: string;
    audience: "worker_poll";
}, {
    protocolVersion: 1;
    workerId: string;
    issuedAt: string;
    targetId: string;
    deviceGeneration: number;
    nonce: string;
    capacity: {
        batchSlots: number;
        browserSessionSlots: number;
        serviceSlots: number;
        freeCpuMillis: number;
        freeMemoryMiB: number;
        freeDiskMiB: number;
    };
    correlationId: string;
    audience: "worker_poll";
}>, {
    protocolVersion: 1;
    workerId: string & z.BRAND<"WorkerId">;
    issuedAt: string;
    targetId: string & z.BRAND<"TargetId">;
    deviceGeneration: number;
    nonce: string;
    capacity: {
        batchSlots: number;
        browserSessionSlots: number;
        serviceSlots: number;
        freeCpuMillis: number;
        freeMemoryMiB: number;
        freeDiskMiB: number;
    };
    correlationId: string;
    audience: "worker_poll";
}, {
    protocolVersion: 1;
    workerId: string;
    issuedAt: string;
    targetId: string;
    deviceGeneration: number;
    nonce: string;
    capacity: {
        batchSlots: number;
        browserSessionSlots: number;
        serviceSlots: number;
        freeCpuMillis: number;
        freeMemoryMiB: number;
        freeDiskMiB: number;
    };
    correlationId: string;
    audience: "worker_poll";
}>;
export type PollRequestV1 = z.infer<typeof pollRequestV1Schema>;
export declare const POLL_RESPONSE_OUTCOMES: readonly ["offer", "no_work", "drain"];
export declare const pollResponseV1Schema: z.ZodEffects<z.ZodDiscriminatedUnion<"outcome", [z.ZodObject<{
    outcome: z.ZodLiteral<"offer">;
    body: z.ZodEffects<z.ZodObject<{
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
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    serverTime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "offer";
    body: {
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
    };
}, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "offer";
    body: {
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
    };
}>, z.ZodObject<{
    outcome: z.ZodLiteral<"no_work">;
    retryAfterMs: z.ZodNumber;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    serverTime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    correlationId: string;
    retryAfterMs: number;
    serverTime: string;
    outcome: "no_work";
}, {
    protocolVersion: 1;
    correlationId: string;
    retryAfterMs: number;
    serverTime: string;
    outcome: "no_work";
}>, z.ZodObject<{
    outcome: z.ZodLiteral<"drain">;
    retryAfterMs: z.ZodNullable<z.ZodNumber>;
    reason: z.ZodNullable<z.ZodString>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    serverTime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    reason: string | null;
    correlationId: string;
    retryAfterMs: number | null;
    serverTime: string;
    outcome: "drain";
}, {
    protocolVersion: 1;
    reason: string | null;
    correlationId: string;
    retryAfterMs: number | null;
    serverTime: string;
    outcome: "drain";
}>]>, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "offer";
    body: {
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
    };
} | {
    protocolVersion: 1;
    correlationId: string;
    retryAfterMs: number;
    serverTime: string;
    outcome: "no_work";
} | {
    protocolVersion: 1;
    reason: string | null;
    correlationId: string;
    retryAfterMs: number | null;
    serverTime: string;
    outcome: "drain";
}, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "offer";
    body: {
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
    };
} | {
    protocolVersion: 1;
    correlationId: string;
    retryAfterMs: number;
    serverTime: string;
    outcome: "no_work";
} | {
    protocolVersion: 1;
    reason: string | null;
    correlationId: string;
    retryAfterMs: number | null;
    serverTime: string;
    outcome: "drain";
}>;
export type PollResponseV1 = z.infer<typeof pollResponseV1Schema>;
export declare const leaseAckOperationRequestV1Schema: z.ZodEffects<z.ZodObject<{
    audience: z.ZodLiteral<"worker_run">;
    idempotencyKey: z.ZodString;
    body: z.ZodEffects<z.ZodObject<{
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
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    issuedAt: z.ZodString;
    nonce: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
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
    };
}, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
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
    };
}>, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
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
    };
}, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
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
    };
}>;
export type LeaseAckOperationRequestV1 = z.infer<typeof leaseAckOperationRequestV1Schema>;
export declare const leaseAckOperationResponseV1Schema: z.ZodEffects<z.ZodDiscriminatedUnion<"outcome", [z.ZodObject<{
    outcome: z.ZodLiteral<"acknowledged">;
    leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
    expiresAt: z.ZodString;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    serverTime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    leaseId: string & z.BRAND<"LeaseId">;
    expiresAt: string;
    correlationId: string;
    serverTime: string;
    outcome: "acknowledged";
}, {
    protocolVersion: 1;
    leaseId: string;
    expiresAt: string;
    correlationId: string;
    serverTime: string;
    outcome: "acknowledged";
}>, z.ZodObject<{
    outcome: z.ZodLiteral<"rejected">;
    reason: z.ZodEnum<["malformed", "unauthorized", "incompatible_protocol", "incompatible_capability", "incompatible_policy", "stale_fence", "sequence_gap", "target_revoked", "event_hash_mismatch", "throttled", "payload_too_large", "attempt_terminal", "internal_unavailable"]>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    serverTime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}, {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}>]>, {
    protocolVersion: 1;
    leaseId: string & z.BRAND<"LeaseId">;
    expiresAt: string;
    correlationId: string;
    serverTime: string;
    outcome: "acknowledged";
} | {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}, {
    protocolVersion: 1;
    leaseId: string;
    expiresAt: string;
    correlationId: string;
    serverTime: string;
    outcome: "acknowledged";
} | {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}>;
export type LeaseAckOperationResponseV1 = z.infer<typeof leaseAckOperationResponseV1Schema>;
export declare const leaseRenewOperationRequestV1Schema: z.ZodEffects<z.ZodObject<{
    audience: z.ZodLiteral<"worker_run">;
    idempotencyKey: z.ZodString;
    body: z.ZodEffects<z.ZodObject<{
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
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    issuedAt: z.ZodString;
    nonce: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
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
    };
}, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
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
    };
}>, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
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
    };
}, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
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
    };
}>;
export type LeaseRenewOperationRequestV1 = z.infer<typeof leaseRenewOperationRequestV1Schema>;
export declare const leaseRenewOperationResponseV1Schema: z.ZodEffects<z.ZodDiscriminatedUnion<"outcome", [z.ZodObject<{
    outcome: z.ZodLiteral<"renewed">;
    body: z.ZodEffects<z.ZodObject<{
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
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    serverTime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "renewed";
    body: {
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
    };
}, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "renewed";
    body: {
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
    };
}>, z.ZodObject<{
    outcome: z.ZodLiteral<"rejected">;
    reason: z.ZodEnum<["malformed", "unauthorized", "incompatible_protocol", "incompatible_capability", "incompatible_policy", "stale_fence", "sequence_gap", "target_revoked", "event_hash_mismatch", "throttled", "payload_too_large", "attempt_terminal", "internal_unavailable"]>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    serverTime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}, {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}>]>, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "renewed";
    body: {
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
    };
} | {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "renewed";
    body: {
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
    };
} | {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}>;
export type LeaseRenewOperationResponseV1 = z.infer<typeof leaseRenewOperationResponseV1Schema>;
export declare const eventUploadOperationRequestV1Schema: z.ZodEffects<z.ZodObject<{
    audience: z.ZodLiteral<"worker_run">;
    idempotencyKey: z.ZodString;
    body: z.ZodEffects<z.ZodObject<{
        events: z.ZodArray<z.ZodEffects<z.ZodDiscriminatedUnion<"eventType", [z.ZodObject<{
            eventType: z.ZodLiteral<"attempt_started">;
            payload: z.ZodObject<{
                sandboxId: z.ZodBranded<z.ZodString, "SandboxId">;
            }, "strict", z.ZodTypeAny, {
                sandboxId: string & z.BRAND<"SandboxId">;
            }, {
                sandboxId: string;
            }>;
            protocolVersion: z.ZodLiteral<1>;
            eventId: z.ZodBranded<z.ZodString, "EventId">;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
            seq: z.ZodNumber;
            eventDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            occurredAt: z.ZodString;
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
        }, "strict", z.ZodTypeAny, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "attempt_started";
            payload: {
                sandboxId: string & z.BRAND<"SandboxId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "attempt_started";
            payload: {
                sandboxId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>, z.ZodObject<{
            eventType: z.ZodLiteral<"log">;
            payload: z.ZodObject<{
                stream: z.ZodEnum<["stdout", "stderr", "system"]>;
                level: z.ZodEnum<["debug", "info", "warn", "error"]>;
                message: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                message: string;
                stream: "system" | "stdout" | "stderr";
                level: "debug" | "info" | "warn" | "error";
            }, {
                message: string;
                stream: "system" | "stdout" | "stderr";
                level: "debug" | "info" | "warn" | "error";
            }>;
            protocolVersion: z.ZodLiteral<1>;
            eventId: z.ZodBranded<z.ZodString, "EventId">;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
            seq: z.ZodNumber;
            eventDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            occurredAt: z.ZodString;
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
        }, "strict", z.ZodTypeAny, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "log";
            payload: {
                message: string;
                stream: "system" | "stdout" | "stderr";
                level: "debug" | "info" | "warn" | "error";
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "log";
            payload: {
                message: string;
                stream: "system" | "stdout" | "stderr";
                level: "debug" | "info" | "warn" | "error";
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>, z.ZodObject<{
            eventType: z.ZodLiteral<"progress">;
            payload: z.ZodObject<{
                message: z.ZodString;
                percent: z.ZodNullable<z.ZodNumber>;
            }, "strict", z.ZodTypeAny, {
                message: string;
                percent: number | null;
            }, {
                message: string;
                percent: number | null;
            }>;
            protocolVersion: z.ZodLiteral<1>;
            eventId: z.ZodBranded<z.ZodString, "EventId">;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
            seq: z.ZodNumber;
            eventDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            occurredAt: z.ZodString;
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
        }, "strict", z.ZodTypeAny, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "progress";
            payload: {
                message: string;
                percent: number | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "progress";
            payload: {
                message: string;
                percent: number | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>, z.ZodObject<{
            eventType: z.ZodLiteral<"usage">;
            payload: z.ZodObject<{
                inputTokens: z.ZodNumber;
                outputTokens: z.ZodNumber;
                cachedInputTokens: z.ZodNumber;
                runtimeMillis: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                inputTokens: number;
                outputTokens: number;
                cachedInputTokens: number;
                runtimeMillis: number;
            }, {
                inputTokens: number;
                outputTokens: number;
                cachedInputTokens: number;
                runtimeMillis: number;
            }>;
            protocolVersion: z.ZodLiteral<1>;
            eventId: z.ZodBranded<z.ZodString, "EventId">;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
            seq: z.ZodNumber;
            eventDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            occurredAt: z.ZodString;
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
        }, "strict", z.ZodTypeAny, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "usage";
            payload: {
                inputTokens: number;
                outputTokens: number;
                cachedInputTokens: number;
                runtimeMillis: number;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "usage";
            payload: {
                inputTokens: number;
                outputTokens: number;
                cachedInputTokens: number;
                runtimeMillis: number;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>, z.ZodObject<{
            eventType: z.ZodLiteral<"artifact_prepared">;
            payload: z.ZodObject<{
                artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
                kind: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                kind: string;
                artifactId: string & z.BRAND<"ArtifactId">;
            }, {
                kind: string;
                artifactId: string;
            }>;
            protocolVersion: z.ZodLiteral<1>;
            eventId: z.ZodBranded<z.ZodString, "EventId">;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
            seq: z.ZodNumber;
            eventDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            occurredAt: z.ZodString;
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
        }, "strict", z.ZodTypeAny, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "artifact_prepared";
            payload: {
                kind: string;
                artifactId: string & z.BRAND<"ArtifactId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "artifact_prepared";
            payload: {
                kind: string;
                artifactId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>, z.ZodObject<{
            eventType: z.ZodLiteral<"browser_observation">;
            payload: z.ZodObject<{
                artifactIds: z.ZodArray<z.ZodBranded<z.ZodString, "ArtifactId">, "many">;
                url: z.ZodNullable<z.ZodString>;
                title: z.ZodNullable<z.ZodString>;
            }, "strict", z.ZodTypeAny, {
                url: string | null;
                artifactIds: (string & z.BRAND<"ArtifactId">)[];
                title: string | null;
            }, {
                url: string | null;
                artifactIds: string[];
                title: string | null;
            }>;
            protocolVersion: z.ZodLiteral<1>;
            eventId: z.ZodBranded<z.ZodString, "EventId">;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
            seq: z.ZodNumber;
            eventDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            occurredAt: z.ZodString;
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
        }, "strict", z.ZodTypeAny, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "browser_observation";
            payload: {
                url: string | null;
                artifactIds: (string & z.BRAND<"ArtifactId">)[];
                title: string | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "browser_observation";
            payload: {
                url: string | null;
                artifactIds: string[];
                title: string | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>, z.ZodObject<{
            eventType: z.ZodLiteral<"browser_approval_requested">;
            payload: z.ZodObject<{
                approvalId: z.ZodString;
                action: z.ZodString;
                summary: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                approvalId: string;
                action: string;
                summary: string;
            }, {
                approvalId: string;
                action: string;
                summary: string;
            }>;
            protocolVersion: z.ZodLiteral<1>;
            eventId: z.ZodBranded<z.ZodString, "EventId">;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
            seq: z.ZodNumber;
            eventDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            occurredAt: z.ZodString;
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
        }, "strict", z.ZodTypeAny, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "browser_approval_requested";
            payload: {
                approvalId: string;
                action: string;
                summary: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "browser_approval_requested";
            payload: {
                approvalId: string;
                action: string;
                summary: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>, z.ZodObject<{
            eventType: z.ZodLiteral<"runtime_decision_requested">;
            payload: z.ZodEffects<z.ZodDiscriminatedUnion<"decisionKind", [z.ZodObject<{
                timeoutPolicy: z.ZodEnum<["deny", "cancel_run", "park_run", "continue_with_default", "escalate"]>;
                defaultDecision: z.ZodNullable<z.ZodEnum<["allow_once", "allow_run", "deny"]>>;
                toolName: z.ZodNullable<z.ZodString>;
                command: z.ZodNullable<z.ZodString>;
                cwd: z.ZodNullable<z.ZodString>;
                path: z.ZodNullable<z.ZodString>;
                networkTarget: z.ZodNullable<z.ZodString>;
                riskClass: z.ZodNullable<z.ZodString>;
                requestId: z.ZodString;
                nonce: z.ZodEffects<z.ZodString, string, string>;
                requestDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
                schemaVersion: z.ZodNumber;
                sourceRevision: z.ZodNumber;
                expiresAt: z.ZodString;
                title: z.ZodString;
                summary: z.ZodNullable<z.ZodString>;
                decisionKind: z.ZodLiteral<"permission">;
            }, "strict", z.ZodTypeAny, {
                path: string | null;
                schemaVersion: number;
                command: string | null;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "permission";
                timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                defaultDecision: "deny" | "allow_once" | "allow_run" | null;
                toolName: string | null;
                cwd: string | null;
                networkTarget: string | null;
                riskClass: string | null;
                requestId: string;
                nonce: string;
                requestDigest: string & z.BRAND<"Sha256Digest">;
                sourceRevision: number;
            }, {
                path: string | null;
                schemaVersion: number;
                command: string | null;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "permission";
                timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                defaultDecision: "deny" | "allow_once" | "allow_run" | null;
                toolName: string | null;
                cwd: string | null;
                networkTarget: string | null;
                riskClass: string | null;
                requestId: string;
                nonce: string;
                requestDigest: string;
                sourceRevision: number;
            }>, z.ZodObject<{
                timeoutPolicy: z.ZodEnum<["cancel_run", "park_run", "continue_with_default", "escalate"]>;
                promptText: z.ZodString;
                options: z.ZodArray<z.ZodObject<{
                    optionId: z.ZodEffects<z.ZodString, string, string>;
                    label: z.ZodEffects<z.ZodString, string, string>;
                    value: z.ZodEffects<z.ZodUnknown, unknown, unknown>;
                    isDefault: z.ZodBoolean;
                }, "strict", z.ZodTypeAny, {
                    optionId: string;
                    label: string;
                    isDefault: boolean;
                    value?: unknown;
                }, {
                    optionId: string;
                    label: string;
                    isDefault: boolean;
                    value?: unknown;
                }>, "many">;
                requestId: z.ZodString;
                nonce: z.ZodEffects<z.ZodString, string, string>;
                requestDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
                schemaVersion: z.ZodNumber;
                sourceRevision: z.ZodNumber;
                expiresAt: z.ZodString;
                title: z.ZodString;
                summary: z.ZodNullable<z.ZodString>;
                decisionKind: z.ZodLiteral<"work_question">;
            }, "strict", z.ZodTypeAny, {
                options: {
                    optionId: string;
                    label: string;
                    isDefault: boolean;
                    value?: unknown;
                }[];
                schemaVersion: number;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "work_question";
                timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                requestId: string;
                nonce: string;
                requestDigest: string & z.BRAND<"Sha256Digest">;
                sourceRevision: number;
                promptText: string;
            }, {
                options: {
                    optionId: string;
                    label: string;
                    isDefault: boolean;
                    value?: unknown;
                }[];
                schemaVersion: number;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "work_question";
                timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                requestId: string;
                nonce: string;
                requestDigest: string;
                sourceRevision: number;
                promptText: string;
            }>]>, {
                path: string | null;
                schemaVersion: number;
                command: string | null;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "permission";
                timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                defaultDecision: "deny" | "allow_once" | "allow_run" | null;
                toolName: string | null;
                cwd: string | null;
                networkTarget: string | null;
                riskClass: string | null;
                requestId: string;
                nonce: string;
                requestDigest: string & z.BRAND<"Sha256Digest">;
                sourceRevision: number;
            } | {
                options: {
                    optionId: string;
                    label: string;
                    isDefault: boolean;
                    value?: unknown;
                }[];
                schemaVersion: number;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "work_question";
                timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                requestId: string;
                nonce: string;
                requestDigest: string & z.BRAND<"Sha256Digest">;
                sourceRevision: number;
                promptText: string;
            }, {
                path: string | null;
                schemaVersion: number;
                command: string | null;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "permission";
                timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                defaultDecision: "deny" | "allow_once" | "allow_run" | null;
                toolName: string | null;
                cwd: string | null;
                networkTarget: string | null;
                riskClass: string | null;
                requestId: string;
                nonce: string;
                requestDigest: string;
                sourceRevision: number;
            } | {
                options: {
                    optionId: string;
                    label: string;
                    isDefault: boolean;
                    value?: unknown;
                }[];
                schemaVersion: number;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "work_question";
                timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                requestId: string;
                nonce: string;
                requestDigest: string;
                sourceRevision: number;
                promptText: string;
            }>;
            protocolVersion: z.ZodLiteral<1>;
            eventId: z.ZodBranded<z.ZodString, "EventId">;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
            seq: z.ZodNumber;
            eventDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            occurredAt: z.ZodString;
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
        }, "strict", z.ZodTypeAny, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "runtime_decision_requested";
            payload: {
                path: string | null;
                schemaVersion: number;
                command: string | null;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "permission";
                timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                defaultDecision: "deny" | "allow_once" | "allow_run" | null;
                toolName: string | null;
                cwd: string | null;
                networkTarget: string | null;
                riskClass: string | null;
                requestId: string;
                nonce: string;
                requestDigest: string & z.BRAND<"Sha256Digest">;
                sourceRevision: number;
            } | {
                options: {
                    optionId: string;
                    label: string;
                    isDefault: boolean;
                    value?: unknown;
                }[];
                schemaVersion: number;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "work_question";
                timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                requestId: string;
                nonce: string;
                requestDigest: string & z.BRAND<"Sha256Digest">;
                sourceRevision: number;
                promptText: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "runtime_decision_requested";
            payload: {
                path: string | null;
                schemaVersion: number;
                command: string | null;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "permission";
                timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                defaultDecision: "deny" | "allow_once" | "allow_run" | null;
                toolName: string | null;
                cwd: string | null;
                networkTarget: string | null;
                riskClass: string | null;
                requestId: string;
                nonce: string;
                requestDigest: string;
                sourceRevision: number;
            } | {
                options: {
                    optionId: string;
                    label: string;
                    isDefault: boolean;
                    value?: unknown;
                }[];
                schemaVersion: number;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "work_question";
                timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                requestId: string;
                nonce: string;
                requestDigest: string;
                sourceRevision: number;
                promptText: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>, z.ZodObject<{
            eventType: z.ZodLiteral<"service_instance_started">;
            payload: z.ZodObject<{
                providerResourceId: z.ZodString;
                serviceId: z.ZodBranded<z.ZodString, "ServiceId">;
                serviceInstanceId: z.ZodBranded<z.ZodString, "ServiceInstanceId">;
                generation: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                providerResourceId: string;
            }, {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                providerResourceId: string;
            }>;
            protocolVersion: z.ZodLiteral<1>;
            eventId: z.ZodBranded<z.ZodString, "EventId">;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
            seq: z.ZodNumber;
            eventDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            occurredAt: z.ZodString;
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
        }, "strict", z.ZodTypeAny, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_instance_started";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                providerResourceId: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_instance_started";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                providerResourceId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>, z.ZodObject<{
            eventType: z.ZodLiteral<"service_health">;
            payload: z.ZodObject<{
                status: z.ZodEnum<["healthy", "unhealthy"]>;
                detail: z.ZodNullable<z.ZodString>;
                serviceId: z.ZodBranded<z.ZodString, "ServiceId">;
                serviceInstanceId: z.ZodBranded<z.ZodString, "ServiceInstanceId">;
                generation: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                status: "healthy" | "unhealthy";
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                detail: string | null;
            }, {
                status: "healthy" | "unhealthy";
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                detail: string | null;
            }>;
            protocolVersion: z.ZodLiteral<1>;
            eventId: z.ZodBranded<z.ZodString, "EventId">;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
            seq: z.ZodNumber;
            eventDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            occurredAt: z.ZodString;
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
        }, "strict", z.ZodTypeAny, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_health";
            payload: {
                status: "healthy" | "unhealthy";
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                detail: string | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_health";
            payload: {
                status: "healthy" | "unhealthy";
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                detail: string | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>, z.ZodObject<{
            eventType: z.ZodLiteral<"service_checkpoint_prepared">;
            payload: z.ZodObject<{
                serviceId: z.ZodBranded<z.ZodString, "ServiceId">;
                serviceInstanceId: z.ZodBranded<z.ZodString, "ServiceInstanceId">;
                generation: z.ZodNumber;
                artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
            }, "strict", z.ZodTypeAny, {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                artifactId: string & z.BRAND<"ArtifactId">;
            }, {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                artifactId: string;
            }>;
            protocolVersion: z.ZodLiteral<1>;
            eventId: z.ZodBranded<z.ZodString, "EventId">;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
            seq: z.ZodNumber;
            eventDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            occurredAt: z.ZodString;
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
        }, "strict", z.ZodTypeAny, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_checkpoint_prepared";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                artifactId: string & z.BRAND<"ArtifactId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_checkpoint_prepared";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                artifactId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>, z.ZodObject<{
            eventType: z.ZodLiteral<"service_checkpoint_restored">;
            payload: z.ZodObject<{
                serviceId: z.ZodBranded<z.ZodString, "ServiceId">;
                serviceInstanceId: z.ZodBranded<z.ZodString, "ServiceInstanceId">;
                generation: z.ZodNumber;
                artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
            }, "strict", z.ZodTypeAny, {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                artifactId: string & z.BRAND<"ArtifactId">;
            }, {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                artifactId: string;
            }>;
            protocolVersion: z.ZodLiteral<1>;
            eventId: z.ZodBranded<z.ZodString, "EventId">;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
            seq: z.ZodNumber;
            eventDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            occurredAt: z.ZodString;
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
        }, "strict", z.ZodTypeAny, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_checkpoint_restored";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                artifactId: string & z.BRAND<"ArtifactId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_checkpoint_restored";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                artifactId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>, z.ZodObject<{
            eventType: z.ZodLiteral<"service_graceful_stop_observed">;
            payload: z.ZodObject<{
                deadline: z.ZodString;
                serviceId: z.ZodBranded<z.ZodString, "ServiceId">;
                serviceInstanceId: z.ZodBranded<z.ZodString, "ServiceInstanceId">;
                generation: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                deadline: string;
            }, {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                deadline: string;
            }>;
            protocolVersion: z.ZodLiteral<1>;
            eventId: z.ZodBranded<z.ZodString, "EventId">;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
            seq: z.ZodNumber;
            eventDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            occurredAt: z.ZodString;
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
        }, "strict", z.ZodTypeAny, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_graceful_stop_observed";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                deadline: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_graceful_stop_observed";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                deadline: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>, z.ZodObject<{
            eventType: z.ZodLiteral<"service_instance_stopped">;
            payload: z.ZodObject<{
                exitCode: z.ZodNullable<z.ZodNumber>;
                serviceId: z.ZodBranded<z.ZodString, "ServiceId">;
                serviceInstanceId: z.ZodBranded<z.ZodString, "ServiceInstanceId">;
                generation: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                exitCode: number | null;
            }, {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                exitCode: number | null;
            }>;
            protocolVersion: z.ZodLiteral<1>;
            eventId: z.ZodBranded<z.ZodString, "EventId">;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
            seq: z.ZodNumber;
            eventDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            occurredAt: z.ZodString;
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
        }, "strict", z.ZodTypeAny, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_instance_stopped";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                exitCode: number | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_instance_stopped";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                exitCode: number | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>, z.ZodObject<{
            eventType: z.ZodLiteral<"service_instance_lost">;
            payload: z.ZodObject<{
                reason: z.ZodString;
                serviceId: z.ZodBranded<z.ZodString, "ServiceId">;
                serviceInstanceId: z.ZodBranded<z.ZodString, "ServiceInstanceId">;
                generation: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                reason: string;
            }, {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                reason: string;
            }>;
            protocolVersion: z.ZodLiteral<1>;
            eventId: z.ZodBranded<z.ZodString, "EventId">;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
            seq: z.ZodNumber;
            eventDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            occurredAt: z.ZodString;
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
        }, "strict", z.ZodTypeAny, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_instance_lost";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                reason: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_instance_lost";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                reason: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>, z.ZodObject<{
            eventType: z.ZodLiteral<"service_provider_interrupted">;
            payload: z.ZodObject<{
                reason: z.ZodString;
                serviceId: z.ZodBranded<z.ZodString, "ServiceId">;
                serviceInstanceId: z.ZodBranded<z.ZodString, "ServiceInstanceId">;
                generation: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                reason: string;
            }, {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                reason: string;
            }>;
            protocolVersion: z.ZodLiteral<1>;
            eventId: z.ZodBranded<z.ZodString, "EventId">;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
            seq: z.ZodNumber;
            eventDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            occurredAt: z.ZodString;
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
        }, "strict", z.ZodTypeAny, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_provider_interrupted";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                reason: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_provider_interrupted";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                reason: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>, z.ZodObject<{
            eventType: z.ZodLiteral<"service_provider_resumed">;
            payload: z.ZodObject<{
                providerResourceId: z.ZodString;
                serviceId: z.ZodBranded<z.ZodString, "ServiceId">;
                serviceInstanceId: z.ZodBranded<z.ZodString, "ServiceInstanceId">;
                generation: z.ZodNumber;
            }, "strict", z.ZodTypeAny, {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                providerResourceId: string;
            }, {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                providerResourceId: string;
            }>;
            protocolVersion: z.ZodLiteral<1>;
            eventId: z.ZodBranded<z.ZodString, "EventId">;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
            seq: z.ZodNumber;
            eventDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            occurredAt: z.ZodString;
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
        }, "strict", z.ZodTypeAny, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_provider_resumed";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                providerResourceId: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_provider_resumed";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                providerResourceId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>, z.ZodObject<{
            eventType: z.ZodLiteral<"network_denied">;
            payload: z.ZodObject<{
                destinationClass: z.ZodEnum<["metadata", "private", "control_plane", "not_allowlisted"]>;
                reason: z.ZodString;
            }, "strict", z.ZodTypeAny, {
                reason: string;
                destinationClass: "metadata" | "private" | "control_plane" | "not_allowlisted";
            }, {
                reason: string;
                destinationClass: "metadata" | "private" | "control_plane" | "not_allowlisted";
            }>;
            protocolVersion: z.ZodLiteral<1>;
            eventId: z.ZodBranded<z.ZodString, "EventId">;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
            seq: z.ZodNumber;
            eventDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            occurredAt: z.ZodString;
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
        }, "strict", z.ZodTypeAny, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "network_denied";
            payload: {
                reason: string;
                destinationClass: "metadata" | "private" | "control_plane" | "not_allowlisted";
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "network_denied";
            payload: {
                reason: string;
                destinationClass: "metadata" | "private" | "control_plane" | "not_allowlisted";
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>, z.ZodObject<{
            eventType: z.ZodLiteral<"terminal">;
            payload: z.ZodObject<{
                status: z.ZodEnum<["succeeded", "failed", "cancelled", "expired"]>;
                exitCode: z.ZodNullable<z.ZodNumber>;
                errorCode: z.ZodNullable<z.ZodString>;
                errorMessage: z.ZodNullable<z.ZodString>;
            }, "strict", z.ZodTypeAny, {
                status: "succeeded" | "failed" | "cancelled" | "expired";
                exitCode: number | null;
                errorCode: string | null;
                errorMessage: string | null;
            }, {
                status: "succeeded" | "failed" | "cancelled" | "expired";
                exitCode: number | null;
                errorCode: string | null;
                errorMessage: string | null;
            }>;
            protocolVersion: z.ZodLiteral<1>;
            eventId: z.ZodBranded<z.ZodString, "EventId">;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
            seq: z.ZodNumber;
            eventDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
            occurredAt: z.ZodString;
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
        }, "strict", z.ZodTypeAny, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "terminal";
            payload: {
                status: "succeeded" | "failed" | "cancelled" | "expired";
                exitCode: number | null;
                errorCode: string | null;
                errorMessage: string | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "terminal";
            payload: {
                status: "succeeded" | "failed" | "cancelled" | "expired";
                exitCode: number | null;
                errorCode: string | null;
                errorMessage: string | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>]>, {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "attempt_started";
            payload: {
                sandboxId: string & z.BRAND<"SandboxId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "log";
            payload: {
                message: string;
                stream: "system" | "stdout" | "stderr";
                level: "debug" | "info" | "warn" | "error";
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "progress";
            payload: {
                message: string;
                percent: number | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "usage";
            payload: {
                inputTokens: number;
                outputTokens: number;
                cachedInputTokens: number;
                runtimeMillis: number;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "artifact_prepared";
            payload: {
                kind: string;
                artifactId: string & z.BRAND<"ArtifactId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "browser_observation";
            payload: {
                url: string | null;
                artifactIds: (string & z.BRAND<"ArtifactId">)[];
                title: string | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "browser_approval_requested";
            payload: {
                approvalId: string;
                action: string;
                summary: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "runtime_decision_requested";
            payload: {
                path: string | null;
                schemaVersion: number;
                command: string | null;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "permission";
                timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                defaultDecision: "deny" | "allow_once" | "allow_run" | null;
                toolName: string | null;
                cwd: string | null;
                networkTarget: string | null;
                riskClass: string | null;
                requestId: string;
                nonce: string;
                requestDigest: string & z.BRAND<"Sha256Digest">;
                sourceRevision: number;
            } | {
                options: {
                    optionId: string;
                    label: string;
                    isDefault: boolean;
                    value?: unknown;
                }[];
                schemaVersion: number;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "work_question";
                timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                requestId: string;
                nonce: string;
                requestDigest: string & z.BRAND<"Sha256Digest">;
                sourceRevision: number;
                promptText: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_instance_started";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                providerResourceId: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_health";
            payload: {
                status: "healthy" | "unhealthy";
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                detail: string | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_checkpoint_prepared";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                artifactId: string & z.BRAND<"ArtifactId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_checkpoint_restored";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                artifactId: string & z.BRAND<"ArtifactId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_graceful_stop_observed";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                deadline: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_instance_stopped";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                exitCode: number | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_instance_lost";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                reason: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_provider_interrupted";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                reason: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_provider_resumed";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                providerResourceId: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "network_denied";
            payload: {
                reason: string;
                destinationClass: "metadata" | "private" | "control_plane" | "not_allowlisted";
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "terminal";
            payload: {
                status: "succeeded" | "failed" | "cancelled" | "expired";
                exitCode: number | null;
                errorCode: string | null;
                errorMessage: string | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        }, {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "attempt_started";
            payload: {
                sandboxId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "log";
            payload: {
                message: string;
                stream: "system" | "stdout" | "stderr";
                level: "debug" | "info" | "warn" | "error";
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "progress";
            payload: {
                message: string;
                percent: number | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "usage";
            payload: {
                inputTokens: number;
                outputTokens: number;
                cachedInputTokens: number;
                runtimeMillis: number;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "artifact_prepared";
            payload: {
                kind: string;
                artifactId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "browser_observation";
            payload: {
                url: string | null;
                artifactIds: string[];
                title: string | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "browser_approval_requested";
            payload: {
                approvalId: string;
                action: string;
                summary: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "runtime_decision_requested";
            payload: {
                path: string | null;
                schemaVersion: number;
                command: string | null;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "permission";
                timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                defaultDecision: "deny" | "allow_once" | "allow_run" | null;
                toolName: string | null;
                cwd: string | null;
                networkTarget: string | null;
                riskClass: string | null;
                requestId: string;
                nonce: string;
                requestDigest: string;
                sourceRevision: number;
            } | {
                options: {
                    optionId: string;
                    label: string;
                    isDefault: boolean;
                    value?: unknown;
                }[];
                schemaVersion: number;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "work_question";
                timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                requestId: string;
                nonce: string;
                requestDigest: string;
                sourceRevision: number;
                promptText: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_instance_started";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                providerResourceId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_health";
            payload: {
                status: "healthy" | "unhealthy";
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                detail: string | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_checkpoint_prepared";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                artifactId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_checkpoint_restored";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                artifactId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_graceful_stop_observed";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                deadline: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_instance_stopped";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                exitCode: number | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_instance_lost";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                reason: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_provider_interrupted";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                reason: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_provider_resumed";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                providerResourceId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "network_denied";
            payload: {
                reason: string;
                destinationClass: "metadata" | "private" | "control_plane" | "not_allowlisted";
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "terminal";
            payload: {
                status: "succeeded" | "failed" | "cancelled" | "expired";
                exitCode: number | null;
                errorCode: string | null;
                errorMessage: string | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        }>, "many">;
        protocolVersion: z.ZodLiteral<1>;
        organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
        companyId: z.ZodBranded<z.ZodString, "CompanyId">;
        workerId: z.ZodBranded<z.ZodString, "WorkerId">;
        jobId: z.ZodBranded<z.ZodString, "JobId">;
        attempt: z.ZodNumber;
        leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
        fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
    }, "strict", z.ZodTypeAny, {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        workerId: string & z.BRAND<"WorkerId">;
        leaseId: string & z.BRAND<"LeaseId">;
        fenceToken: string & z.BRAND<"FenceToken">;
        events: ({
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "attempt_started";
            payload: {
                sandboxId: string & z.BRAND<"SandboxId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "log";
            payload: {
                message: string;
                stream: "system" | "stdout" | "stderr";
                level: "debug" | "info" | "warn" | "error";
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "progress";
            payload: {
                message: string;
                percent: number | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "usage";
            payload: {
                inputTokens: number;
                outputTokens: number;
                cachedInputTokens: number;
                runtimeMillis: number;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "artifact_prepared";
            payload: {
                kind: string;
                artifactId: string & z.BRAND<"ArtifactId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "browser_observation";
            payload: {
                url: string | null;
                artifactIds: (string & z.BRAND<"ArtifactId">)[];
                title: string | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "browser_approval_requested";
            payload: {
                approvalId: string;
                action: string;
                summary: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "runtime_decision_requested";
            payload: {
                path: string | null;
                schemaVersion: number;
                command: string | null;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "permission";
                timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                defaultDecision: "deny" | "allow_once" | "allow_run" | null;
                toolName: string | null;
                cwd: string | null;
                networkTarget: string | null;
                riskClass: string | null;
                requestId: string;
                nonce: string;
                requestDigest: string & z.BRAND<"Sha256Digest">;
                sourceRevision: number;
            } | {
                options: {
                    optionId: string;
                    label: string;
                    isDefault: boolean;
                    value?: unknown;
                }[];
                schemaVersion: number;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "work_question";
                timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                requestId: string;
                nonce: string;
                requestDigest: string & z.BRAND<"Sha256Digest">;
                sourceRevision: number;
                promptText: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_instance_started";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                providerResourceId: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_health";
            payload: {
                status: "healthy" | "unhealthy";
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                detail: string | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_checkpoint_prepared";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                artifactId: string & z.BRAND<"ArtifactId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_checkpoint_restored";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                artifactId: string & z.BRAND<"ArtifactId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_graceful_stop_observed";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                deadline: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_instance_stopped";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                exitCode: number | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_instance_lost";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                reason: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_provider_interrupted";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                reason: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_provider_resumed";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                providerResourceId: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "network_denied";
            payload: {
                reason: string;
                destinationClass: "metadata" | "private" | "control_plane" | "not_allowlisted";
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "terminal";
            payload: {
                status: "succeeded" | "failed" | "cancelled" | "expired";
                exitCode: number | null;
                errorCode: string | null;
                errorMessage: string | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        })[];
    }, {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        workerId: string;
        leaseId: string;
        fenceToken: string;
        events: ({
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "attempt_started";
            payload: {
                sandboxId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "log";
            payload: {
                message: string;
                stream: "system" | "stdout" | "stderr";
                level: "debug" | "info" | "warn" | "error";
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "progress";
            payload: {
                message: string;
                percent: number | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "usage";
            payload: {
                inputTokens: number;
                outputTokens: number;
                cachedInputTokens: number;
                runtimeMillis: number;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "artifact_prepared";
            payload: {
                kind: string;
                artifactId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "browser_observation";
            payload: {
                url: string | null;
                artifactIds: string[];
                title: string | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "browser_approval_requested";
            payload: {
                approvalId: string;
                action: string;
                summary: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "runtime_decision_requested";
            payload: {
                path: string | null;
                schemaVersion: number;
                command: string | null;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "permission";
                timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                defaultDecision: "deny" | "allow_once" | "allow_run" | null;
                toolName: string | null;
                cwd: string | null;
                networkTarget: string | null;
                riskClass: string | null;
                requestId: string;
                nonce: string;
                requestDigest: string;
                sourceRevision: number;
            } | {
                options: {
                    optionId: string;
                    label: string;
                    isDefault: boolean;
                    value?: unknown;
                }[];
                schemaVersion: number;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "work_question";
                timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                requestId: string;
                nonce: string;
                requestDigest: string;
                sourceRevision: number;
                promptText: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_instance_started";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                providerResourceId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_health";
            payload: {
                status: "healthy" | "unhealthy";
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                detail: string | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_checkpoint_prepared";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                artifactId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_checkpoint_restored";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                artifactId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_graceful_stop_observed";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                deadline: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_instance_stopped";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                exitCode: number | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_instance_lost";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                reason: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_provider_interrupted";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                reason: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_provider_resumed";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                providerResourceId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "network_denied";
            payload: {
                reason: string;
                destinationClass: "metadata" | "private" | "control_plane" | "not_allowlisted";
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "terminal";
            payload: {
                status: "succeeded" | "failed" | "cancelled" | "expired";
                exitCode: number | null;
                errorCode: string | null;
                errorMessage: string | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        })[];
    }>, {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        workerId: string & z.BRAND<"WorkerId">;
        leaseId: string & z.BRAND<"LeaseId">;
        fenceToken: string & z.BRAND<"FenceToken">;
        events: ({
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "attempt_started";
            payload: {
                sandboxId: string & z.BRAND<"SandboxId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "log";
            payload: {
                message: string;
                stream: "system" | "stdout" | "stderr";
                level: "debug" | "info" | "warn" | "error";
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "progress";
            payload: {
                message: string;
                percent: number | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "usage";
            payload: {
                inputTokens: number;
                outputTokens: number;
                cachedInputTokens: number;
                runtimeMillis: number;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "artifact_prepared";
            payload: {
                kind: string;
                artifactId: string & z.BRAND<"ArtifactId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "browser_observation";
            payload: {
                url: string | null;
                artifactIds: (string & z.BRAND<"ArtifactId">)[];
                title: string | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "browser_approval_requested";
            payload: {
                approvalId: string;
                action: string;
                summary: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "runtime_decision_requested";
            payload: {
                path: string | null;
                schemaVersion: number;
                command: string | null;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "permission";
                timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                defaultDecision: "deny" | "allow_once" | "allow_run" | null;
                toolName: string | null;
                cwd: string | null;
                networkTarget: string | null;
                riskClass: string | null;
                requestId: string;
                nonce: string;
                requestDigest: string & z.BRAND<"Sha256Digest">;
                sourceRevision: number;
            } | {
                options: {
                    optionId: string;
                    label: string;
                    isDefault: boolean;
                    value?: unknown;
                }[];
                schemaVersion: number;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "work_question";
                timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                requestId: string;
                nonce: string;
                requestDigest: string & z.BRAND<"Sha256Digest">;
                sourceRevision: number;
                promptText: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_instance_started";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                providerResourceId: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_health";
            payload: {
                status: "healthy" | "unhealthy";
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                detail: string | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_checkpoint_prepared";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                artifactId: string & z.BRAND<"ArtifactId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_checkpoint_restored";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                artifactId: string & z.BRAND<"ArtifactId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_graceful_stop_observed";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                deadline: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_instance_stopped";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                exitCode: number | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_instance_lost";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                reason: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_provider_interrupted";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                reason: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_provider_resumed";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                providerResourceId: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "network_denied";
            payload: {
                reason: string;
                destinationClass: "metadata" | "private" | "control_plane" | "not_allowlisted";
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "terminal";
            payload: {
                status: "succeeded" | "failed" | "cancelled" | "expired";
                exitCode: number | null;
                errorCode: string | null;
                errorMessage: string | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        })[];
    }, {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        workerId: string;
        leaseId: string;
        fenceToken: string;
        events: ({
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "attempt_started";
            payload: {
                sandboxId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "log";
            payload: {
                message: string;
                stream: "system" | "stdout" | "stderr";
                level: "debug" | "info" | "warn" | "error";
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "progress";
            payload: {
                message: string;
                percent: number | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "usage";
            payload: {
                inputTokens: number;
                outputTokens: number;
                cachedInputTokens: number;
                runtimeMillis: number;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "artifact_prepared";
            payload: {
                kind: string;
                artifactId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "browser_observation";
            payload: {
                url: string | null;
                artifactIds: string[];
                title: string | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "browser_approval_requested";
            payload: {
                approvalId: string;
                action: string;
                summary: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "runtime_decision_requested";
            payload: {
                path: string | null;
                schemaVersion: number;
                command: string | null;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "permission";
                timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                defaultDecision: "deny" | "allow_once" | "allow_run" | null;
                toolName: string | null;
                cwd: string | null;
                networkTarget: string | null;
                riskClass: string | null;
                requestId: string;
                nonce: string;
                requestDigest: string;
                sourceRevision: number;
            } | {
                options: {
                    optionId: string;
                    label: string;
                    isDefault: boolean;
                    value?: unknown;
                }[];
                schemaVersion: number;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "work_question";
                timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                requestId: string;
                nonce: string;
                requestDigest: string;
                sourceRevision: number;
                promptText: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_instance_started";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                providerResourceId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_health";
            payload: {
                status: "healthy" | "unhealthy";
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                detail: string | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_checkpoint_prepared";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                artifactId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_checkpoint_restored";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                artifactId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_graceful_stop_observed";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                deadline: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_instance_stopped";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                exitCode: number | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_instance_lost";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                reason: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_provider_interrupted";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                reason: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_provider_resumed";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                providerResourceId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "network_denied";
            payload: {
                reason: string;
                destinationClass: "metadata" | "private" | "control_plane" | "not_allowlisted";
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "terminal";
            payload: {
                status: "succeeded" | "failed" | "cancelled" | "expired";
                exitCode: number | null;
                errorCode: string | null;
                errorMessage: string | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        })[];
    }>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    issuedAt: z.ZodString;
    nonce: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        workerId: string & z.BRAND<"WorkerId">;
        leaseId: string & z.BRAND<"LeaseId">;
        fenceToken: string & z.BRAND<"FenceToken">;
        events: ({
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "attempt_started";
            payload: {
                sandboxId: string & z.BRAND<"SandboxId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "log";
            payload: {
                message: string;
                stream: "system" | "stdout" | "stderr";
                level: "debug" | "info" | "warn" | "error";
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "progress";
            payload: {
                message: string;
                percent: number | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "usage";
            payload: {
                inputTokens: number;
                outputTokens: number;
                cachedInputTokens: number;
                runtimeMillis: number;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "artifact_prepared";
            payload: {
                kind: string;
                artifactId: string & z.BRAND<"ArtifactId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "browser_observation";
            payload: {
                url: string | null;
                artifactIds: (string & z.BRAND<"ArtifactId">)[];
                title: string | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "browser_approval_requested";
            payload: {
                approvalId: string;
                action: string;
                summary: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "runtime_decision_requested";
            payload: {
                path: string | null;
                schemaVersion: number;
                command: string | null;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "permission";
                timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                defaultDecision: "deny" | "allow_once" | "allow_run" | null;
                toolName: string | null;
                cwd: string | null;
                networkTarget: string | null;
                riskClass: string | null;
                requestId: string;
                nonce: string;
                requestDigest: string & z.BRAND<"Sha256Digest">;
                sourceRevision: number;
            } | {
                options: {
                    optionId: string;
                    label: string;
                    isDefault: boolean;
                    value?: unknown;
                }[];
                schemaVersion: number;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "work_question";
                timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                requestId: string;
                nonce: string;
                requestDigest: string & z.BRAND<"Sha256Digest">;
                sourceRevision: number;
                promptText: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_instance_started";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                providerResourceId: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_health";
            payload: {
                status: "healthy" | "unhealthy";
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                detail: string | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_checkpoint_prepared";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                artifactId: string & z.BRAND<"ArtifactId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_checkpoint_restored";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                artifactId: string & z.BRAND<"ArtifactId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_graceful_stop_observed";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                deadline: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_instance_stopped";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                exitCode: number | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_instance_lost";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                reason: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_provider_interrupted";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                reason: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_provider_resumed";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                providerResourceId: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "network_denied";
            payload: {
                reason: string;
                destinationClass: "metadata" | "private" | "control_plane" | "not_allowlisted";
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "terminal";
            payload: {
                status: "succeeded" | "failed" | "cancelled" | "expired";
                exitCode: number | null;
                errorCode: string | null;
                errorMessage: string | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        })[];
    };
}, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        workerId: string;
        leaseId: string;
        fenceToken: string;
        events: ({
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "attempt_started";
            payload: {
                sandboxId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "log";
            payload: {
                message: string;
                stream: "system" | "stdout" | "stderr";
                level: "debug" | "info" | "warn" | "error";
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "progress";
            payload: {
                message: string;
                percent: number | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "usage";
            payload: {
                inputTokens: number;
                outputTokens: number;
                cachedInputTokens: number;
                runtimeMillis: number;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "artifact_prepared";
            payload: {
                kind: string;
                artifactId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "browser_observation";
            payload: {
                url: string | null;
                artifactIds: string[];
                title: string | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "browser_approval_requested";
            payload: {
                approvalId: string;
                action: string;
                summary: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "runtime_decision_requested";
            payload: {
                path: string | null;
                schemaVersion: number;
                command: string | null;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "permission";
                timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                defaultDecision: "deny" | "allow_once" | "allow_run" | null;
                toolName: string | null;
                cwd: string | null;
                networkTarget: string | null;
                riskClass: string | null;
                requestId: string;
                nonce: string;
                requestDigest: string;
                sourceRevision: number;
            } | {
                options: {
                    optionId: string;
                    label: string;
                    isDefault: boolean;
                    value?: unknown;
                }[];
                schemaVersion: number;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "work_question";
                timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                requestId: string;
                nonce: string;
                requestDigest: string;
                sourceRevision: number;
                promptText: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_instance_started";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                providerResourceId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_health";
            payload: {
                status: "healthy" | "unhealthy";
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                detail: string | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_checkpoint_prepared";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                artifactId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_checkpoint_restored";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                artifactId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_graceful_stop_observed";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                deadline: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_instance_stopped";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                exitCode: number | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_instance_lost";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                reason: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_provider_interrupted";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                reason: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_provider_resumed";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                providerResourceId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "network_denied";
            payload: {
                reason: string;
                destinationClass: "metadata" | "private" | "control_plane" | "not_allowlisted";
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "terminal";
            payload: {
                status: "succeeded" | "failed" | "cancelled" | "expired";
                exitCode: number | null;
                errorCode: string | null;
                errorMessage: string | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        })[];
    };
}>, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        workerId: string & z.BRAND<"WorkerId">;
        leaseId: string & z.BRAND<"LeaseId">;
        fenceToken: string & z.BRAND<"FenceToken">;
        events: ({
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "attempt_started";
            payload: {
                sandboxId: string & z.BRAND<"SandboxId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "log";
            payload: {
                message: string;
                stream: "system" | "stdout" | "stderr";
                level: "debug" | "info" | "warn" | "error";
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "progress";
            payload: {
                message: string;
                percent: number | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "usage";
            payload: {
                inputTokens: number;
                outputTokens: number;
                cachedInputTokens: number;
                runtimeMillis: number;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "artifact_prepared";
            payload: {
                kind: string;
                artifactId: string & z.BRAND<"ArtifactId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "browser_observation";
            payload: {
                url: string | null;
                artifactIds: (string & z.BRAND<"ArtifactId">)[];
                title: string | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "browser_approval_requested";
            payload: {
                approvalId: string;
                action: string;
                summary: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "runtime_decision_requested";
            payload: {
                path: string | null;
                schemaVersion: number;
                command: string | null;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "permission";
                timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                defaultDecision: "deny" | "allow_once" | "allow_run" | null;
                toolName: string | null;
                cwd: string | null;
                networkTarget: string | null;
                riskClass: string | null;
                requestId: string;
                nonce: string;
                requestDigest: string & z.BRAND<"Sha256Digest">;
                sourceRevision: number;
            } | {
                options: {
                    optionId: string;
                    label: string;
                    isDefault: boolean;
                    value?: unknown;
                }[];
                schemaVersion: number;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "work_question";
                timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                requestId: string;
                nonce: string;
                requestDigest: string & z.BRAND<"Sha256Digest">;
                sourceRevision: number;
                promptText: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_instance_started";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                providerResourceId: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_health";
            payload: {
                status: "healthy" | "unhealthy";
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                detail: string | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_checkpoint_prepared";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                artifactId: string & z.BRAND<"ArtifactId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_checkpoint_restored";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                artifactId: string & z.BRAND<"ArtifactId">;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_graceful_stop_observed";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                deadline: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_instance_stopped";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                exitCode: number | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_instance_lost";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                reason: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_provider_interrupted";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                reason: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "service_provider_resumed";
            payload: {
                serviceId: string & z.BRAND<"ServiceId">;
                generation: number;
                serviceInstanceId: string & z.BRAND<"ServiceInstanceId">;
                providerResourceId: string;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "network_denied";
            payload: {
                reason: string;
                destinationClass: "metadata" | "private" | "control_plane" | "not_allowlisted";
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            eventType: "terminal";
            payload: {
                status: "succeeded" | "failed" | "cancelled" | "expired";
                exitCode: number | null;
                errorCode: string | null;
                errorMessage: string | null;
            };
            eventId: string & z.BRAND<"EventId">;
            seq: number;
            occurredAt: string;
        })[];
    };
}, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        workerId: string;
        leaseId: string;
        fenceToken: string;
        events: ({
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "attempt_started";
            payload: {
                sandboxId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "log";
            payload: {
                message: string;
                stream: "system" | "stdout" | "stderr";
                level: "debug" | "info" | "warn" | "error";
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "progress";
            payload: {
                message: string;
                percent: number | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "usage";
            payload: {
                inputTokens: number;
                outputTokens: number;
                cachedInputTokens: number;
                runtimeMillis: number;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "artifact_prepared";
            payload: {
                kind: string;
                artifactId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "browser_observation";
            payload: {
                url: string | null;
                artifactIds: string[];
                title: string | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "browser_approval_requested";
            payload: {
                approvalId: string;
                action: string;
                summary: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "runtime_decision_requested";
            payload: {
                path: string | null;
                schemaVersion: number;
                command: string | null;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "permission";
                timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                defaultDecision: "deny" | "allow_once" | "allow_run" | null;
                toolName: string | null;
                cwd: string | null;
                networkTarget: string | null;
                riskClass: string | null;
                requestId: string;
                nonce: string;
                requestDigest: string;
                sourceRevision: number;
            } | {
                options: {
                    optionId: string;
                    label: string;
                    isDefault: boolean;
                    value?: unknown;
                }[];
                schemaVersion: number;
                expiresAt: string;
                title: string;
                summary: string | null;
                decisionKind: "work_question";
                timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
                requestId: string;
                nonce: string;
                requestDigest: string;
                sourceRevision: number;
                promptText: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_instance_started";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                providerResourceId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_health";
            payload: {
                status: "healthy" | "unhealthy";
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                detail: string | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_checkpoint_prepared";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                artifactId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_checkpoint_restored";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                artifactId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_graceful_stop_observed";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                deadline: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_instance_stopped";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                exitCode: number | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_instance_lost";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                reason: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_provider_interrupted";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                reason: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "service_provider_resumed";
            payload: {
                serviceId: string;
                generation: number;
                serviceInstanceId: string;
                providerResourceId: string;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "network_denied";
            payload: {
                reason: string;
                destinationClass: "metadata" | "private" | "control_plane" | "not_allowlisted";
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        } | {
            eventDigest: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            extensions: {
                namespace: string;
                schemaVersion: number;
                critical: boolean;
                value?: unknown;
            }[];
            workerId: string;
            leaseId: string;
            fenceToken: string;
            eventType: "terminal";
            payload: {
                status: "succeeded" | "failed" | "cancelled" | "expired";
                exitCode: number | null;
                errorCode: string | null;
                errorMessage: string | null;
            };
            eventId: string;
            seq: number;
            occurredAt: string;
        })[];
    };
}>;
export type EventUploadOperationRequestV1 = z.infer<typeof eventUploadOperationRequestV1Schema>;
export declare const eventUploadOperationResponseV1Schema: z.ZodEffects<z.ZodObject<{
    ack: z.ZodEffects<z.ZodObject<{
        acceptedThroughSeq: z.ZodNumber;
        expectedNextSeq: z.ZodNumber;
        status: z.ZodEnum<["accepted", "gap", "hash_mismatch", "stale_fence", "target_revoked", "terminal"]>;
        rejectedEventId: z.ZodOptional<z.ZodBranded<z.ZodString, "EventId">>;
        protocolVersion: z.ZodLiteral<1>;
        organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
        companyId: z.ZodBranded<z.ZodString, "CompanyId">;
        workerId: z.ZodBranded<z.ZodString, "WorkerId">;
        jobId: z.ZodBranded<z.ZodString, "JobId">;
        attempt: z.ZodNumber;
        leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
        fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
    }, "strict", z.ZodTypeAny, {
        status: "stale_fence" | "hash_mismatch" | "terminal" | "accepted" | "gap" | "target_revoked";
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        workerId: string & z.BRAND<"WorkerId">;
        leaseId: string & z.BRAND<"LeaseId">;
        fenceToken: string & z.BRAND<"FenceToken">;
        acceptedThroughSeq: number;
        expectedNextSeq: number;
        rejectedEventId?: (string & z.BRAND<"EventId">) | undefined;
    }, {
        status: "stale_fence" | "hash_mismatch" | "terminal" | "accepted" | "gap" | "target_revoked";
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        workerId: string;
        leaseId: string;
        fenceToken: string;
        acceptedThroughSeq: number;
        expectedNextSeq: number;
        rejectedEventId?: string | undefined;
    }>, {
        status: "stale_fence" | "hash_mismatch" | "terminal" | "accepted" | "gap" | "target_revoked";
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        workerId: string & z.BRAND<"WorkerId">;
        leaseId: string & z.BRAND<"LeaseId">;
        fenceToken: string & z.BRAND<"FenceToken">;
        acceptedThroughSeq: number;
        expectedNextSeq: number;
        rejectedEventId?: (string & z.BRAND<"EventId">) | undefined;
    }, {
        status: "stale_fence" | "hash_mismatch" | "terminal" | "accepted" | "gap" | "target_revoked";
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        workerId: string;
        leaseId: string;
        fenceToken: string;
        acceptedThroughSeq: number;
        expectedNextSeq: number;
        rejectedEventId?: string | undefined;
    }>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    serverTime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    ack: {
        status: "stale_fence" | "hash_mismatch" | "terminal" | "accepted" | "gap" | "target_revoked";
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        workerId: string & z.BRAND<"WorkerId">;
        leaseId: string & z.BRAND<"LeaseId">;
        fenceToken: string & z.BRAND<"FenceToken">;
        acceptedThroughSeq: number;
        expectedNextSeq: number;
        rejectedEventId?: (string & z.BRAND<"EventId">) | undefined;
    };
}, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    ack: {
        status: "stale_fence" | "hash_mismatch" | "terminal" | "accepted" | "gap" | "target_revoked";
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        workerId: string;
        leaseId: string;
        fenceToken: string;
        acceptedThroughSeq: number;
        expectedNextSeq: number;
        rejectedEventId?: string | undefined;
    };
}>, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    ack: {
        status: "stale_fence" | "hash_mismatch" | "terminal" | "accepted" | "gap" | "target_revoked";
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        workerId: string & z.BRAND<"WorkerId">;
        leaseId: string & z.BRAND<"LeaseId">;
        fenceToken: string & z.BRAND<"FenceToken">;
        acceptedThroughSeq: number;
        expectedNextSeq: number;
        rejectedEventId?: (string & z.BRAND<"EventId">) | undefined;
    };
}, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    ack: {
        status: "stale_fence" | "hash_mismatch" | "terminal" | "accepted" | "gap" | "target_revoked";
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        workerId: string;
        leaseId: string;
        fenceToken: string;
        acceptedThroughSeq: number;
        expectedNextSeq: number;
        rejectedEventId?: string | undefined;
    };
}>;
export type EventUploadOperationResponseV1 = z.infer<typeof eventUploadOperationResponseV1Schema>;
export declare const artifactTransferGrantOperationRequestV1Schema: z.ZodEffects<z.ZodObject<{
    audience: z.ZodLiteral<"worker_run">;
    idempotencyKey: z.ZodString;
    body: z.ZodEffects<z.ZodObject<{
        protocolVersion: z.ZodLiteral<1>;
        operation: z.ZodEnum<["upload", "download"]>;
        workerId: z.ZodBranded<z.ZodString, "WorkerId">;
        jobId: z.ZodBranded<z.ZodString, "JobId">;
        attempt: z.ZodNumber;
        leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
        fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
        artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
        expectedObjectKey: z.ZodString;
        expectedSha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
        maxBytes: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        workerId: string & z.BRAND<"WorkerId">;
        leaseId: string & z.BRAND<"LeaseId">;
        fenceToken: string & z.BRAND<"FenceToken">;
        artifactId: string & z.BRAND<"ArtifactId">;
        operation: "download" | "upload";
        expectedObjectKey: string;
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        maxBytes: number;
    }, {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        workerId: string;
        leaseId: string;
        fenceToken: string;
        artifactId: string;
        operation: "download" | "upload";
        expectedObjectKey: string;
        expectedSha256: string;
        maxBytes: number;
    }>, {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        workerId: string & z.BRAND<"WorkerId">;
        leaseId: string & z.BRAND<"LeaseId">;
        fenceToken: string & z.BRAND<"FenceToken">;
        artifactId: string & z.BRAND<"ArtifactId">;
        operation: "download" | "upload";
        expectedObjectKey: string;
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        maxBytes: number;
    }, {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        workerId: string;
        leaseId: string;
        fenceToken: string;
        artifactId: string;
        operation: "download" | "upload";
        expectedObjectKey: string;
        expectedSha256: string;
        maxBytes: number;
    }>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    issuedAt: z.ZodString;
    nonce: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        workerId: string & z.BRAND<"WorkerId">;
        leaseId: string & z.BRAND<"LeaseId">;
        fenceToken: string & z.BRAND<"FenceToken">;
        artifactId: string & z.BRAND<"ArtifactId">;
        operation: "download" | "upload";
        expectedObjectKey: string;
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        maxBytes: number;
    };
}, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        workerId: string;
        leaseId: string;
        fenceToken: string;
        artifactId: string;
        operation: "download" | "upload";
        expectedObjectKey: string;
        expectedSha256: string;
        maxBytes: number;
    };
}>, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        workerId: string & z.BRAND<"WorkerId">;
        leaseId: string & z.BRAND<"LeaseId">;
        fenceToken: string & z.BRAND<"FenceToken">;
        artifactId: string & z.BRAND<"ArtifactId">;
        operation: "download" | "upload";
        expectedObjectKey: string;
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        maxBytes: number;
    };
}, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        workerId: string;
        leaseId: string;
        fenceToken: string;
        artifactId: string;
        operation: "download" | "upload";
        expectedObjectKey: string;
        expectedSha256: string;
        maxBytes: number;
    };
}>;
export type ArtifactTransferGrantOperationRequestV1 = z.infer<typeof artifactTransferGrantOperationRequestV1Schema>;
export declare const ARTIFACT_TRANSFER_GRANT_OUTCOMES: readonly ["upload_granted", "download_granted", "rejected"];
export declare const artifactTransferGrantOperationResponseV1Schema: z.ZodEffects<z.ZodDiscriminatedUnion<"outcome", [z.ZodObject<{
    outcome: z.ZodLiteral<"upload_granted">;
    grant: z.ZodEffects<z.ZodObject<{
        protocolVersion: z.ZodLiteral<1>;
        operation: z.ZodLiteral<"upload">;
        artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
        method: z.ZodLiteral<"PUT">;
        url: z.ZodString;
        headers: z.ZodRecord<z.ZodString, z.ZodString>;
        issuedAt: z.ZodString;
        expiresAt: z.ZodString;
        maxBytes: z.ZodNumber;
        expectedSha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
        objectKey: z.ZodString;
        redaction: z.ZodLiteral<"secret">;
    }, "strict", z.ZodTypeAny, {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string & z.BRAND<"ArtifactId">;
        objectKey: string;
        url: string;
        headers: Record<string, string>;
        operation: "upload";
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        maxBytes: number;
        method: "PUT";
        issuedAt: string;
        redaction: "secret";
    }, {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string;
        objectKey: string;
        url: string;
        headers: Record<string, string>;
        operation: "upload";
        expectedSha256: string;
        maxBytes: number;
        method: "PUT";
        issuedAt: string;
        redaction: "secret";
    }>, {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string & z.BRAND<"ArtifactId">;
        objectKey: string;
        url: string;
        headers: Record<string, string>;
        operation: "upload";
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        maxBytes: number;
        method: "PUT";
        issuedAt: string;
        redaction: "secret";
    }, {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string;
        objectKey: string;
        url: string;
        headers: Record<string, string>;
        operation: "upload";
        expectedSha256: string;
        maxBytes: number;
        method: "PUT";
        issuedAt: string;
        redaction: "secret";
    }>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    serverTime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "upload_granted";
    grant: {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string & z.BRAND<"ArtifactId">;
        objectKey: string;
        url: string;
        headers: Record<string, string>;
        operation: "upload";
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        maxBytes: number;
        method: "PUT";
        issuedAt: string;
        redaction: "secret";
    };
}, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "upload_granted";
    grant: {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string;
        objectKey: string;
        url: string;
        headers: Record<string, string>;
        operation: "upload";
        expectedSha256: string;
        maxBytes: number;
        method: "PUT";
        issuedAt: string;
        redaction: "secret";
    };
}>, z.ZodObject<{
    outcome: z.ZodLiteral<"download_granted">;
    grant: z.ZodEffects<z.ZodObject<{
        protocolVersion: z.ZodLiteral<1>;
        operation: z.ZodLiteral<"download">;
        artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
        method: z.ZodLiteral<"GET">;
        url: z.ZodString;
        headers: z.ZodRecord<z.ZodString, z.ZodString>;
        issuedAt: z.ZodString;
        expiresAt: z.ZodString;
        maxBytes: z.ZodNumber;
        expectedSha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
        objectKey: z.ZodString;
        redaction: z.ZodLiteral<"secret">;
    }, "strict", z.ZodTypeAny, {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string & z.BRAND<"ArtifactId">;
        objectKey: string;
        url: string;
        headers: Record<string, string>;
        operation: "download";
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        maxBytes: number;
        method: "GET";
        issuedAt: string;
        redaction: "secret";
    }, {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string;
        objectKey: string;
        url: string;
        headers: Record<string, string>;
        operation: "download";
        expectedSha256: string;
        maxBytes: number;
        method: "GET";
        issuedAt: string;
        redaction: "secret";
    }>, {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string & z.BRAND<"ArtifactId">;
        objectKey: string;
        url: string;
        headers: Record<string, string>;
        operation: "download";
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        maxBytes: number;
        method: "GET";
        issuedAt: string;
        redaction: "secret";
    }, {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string;
        objectKey: string;
        url: string;
        headers: Record<string, string>;
        operation: "download";
        expectedSha256: string;
        maxBytes: number;
        method: "GET";
        issuedAt: string;
        redaction: "secret";
    }>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    serverTime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "download_granted";
    grant: {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string & z.BRAND<"ArtifactId">;
        objectKey: string;
        url: string;
        headers: Record<string, string>;
        operation: "download";
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        maxBytes: number;
        method: "GET";
        issuedAt: string;
        redaction: "secret";
    };
}, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "download_granted";
    grant: {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string;
        objectKey: string;
        url: string;
        headers: Record<string, string>;
        operation: "download";
        expectedSha256: string;
        maxBytes: number;
        method: "GET";
        issuedAt: string;
        redaction: "secret";
    };
}>, z.ZodObject<{
    outcome: z.ZodLiteral<"rejected">;
    reason: z.ZodEnum<["malformed", "unauthorized", "incompatible_protocol", "incompatible_capability", "incompatible_policy", "stale_fence", "sequence_gap", "target_revoked", "event_hash_mismatch", "throttled", "payload_too_large", "attempt_terminal", "internal_unavailable"]>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    serverTime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}, {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}>]>, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "upload_granted";
    grant: {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string & z.BRAND<"ArtifactId">;
        objectKey: string;
        url: string;
        headers: Record<string, string>;
        operation: "upload";
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        maxBytes: number;
        method: "PUT";
        issuedAt: string;
        redaction: "secret";
    };
} | {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "download_granted";
    grant: {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string & z.BRAND<"ArtifactId">;
        objectKey: string;
        url: string;
        headers: Record<string, string>;
        operation: "download";
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        maxBytes: number;
        method: "GET";
        issuedAt: string;
        redaction: "secret";
    };
} | {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "upload_granted";
    grant: {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string;
        objectKey: string;
        url: string;
        headers: Record<string, string>;
        operation: "upload";
        expectedSha256: string;
        maxBytes: number;
        method: "PUT";
        issuedAt: string;
        redaction: "secret";
    };
} | {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "download_granted";
    grant: {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string;
        objectKey: string;
        url: string;
        headers: Record<string, string>;
        operation: "download";
        expectedSha256: string;
        maxBytes: number;
        method: "GET";
        issuedAt: string;
        redaction: "secret";
    };
} | {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}>;
export type ArtifactTransferGrantOperationResponseV1 = z.infer<typeof artifactTransferGrantOperationResponseV1Schema>;
/** The CLOSED transfer-grant pairing: an upload request may only be answered by
 * `upload_granted` or `rejected`; a download request only by `download_granted`
 * or `rejected`. No cross grant is permitted. */
export declare function isTransferGrantResponsePairedV1(requestOperation: "upload" | "download", responseOutcome: string): boolean;
export declare const artifactCommitOperationRequestV1Schema: z.ZodEffects<z.ZodObject<{
    audience: z.ZodLiteral<"worker_run">;
    idempotencyKey: z.ZodString;
    body: z.ZodEffects<z.ZodObject<{
        protocolVersion: z.ZodLiteral<1>;
        workerId: z.ZodBranded<z.ZodString, "WorkerId">;
        jobId: z.ZodBranded<z.ZodString, "JobId">;
        attempt: z.ZodNumber;
        leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
        fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
        manifest: z.ZodEffects<z.ZodObject<{
            protocolVersion: z.ZodLiteral<1>;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
            kind: z.ZodEnum<["workspace_snapshot", "workspace_patch", "log", "screenshot", "dom_snapshot", "browser_cookie_state", "browser_storage_state", "playwright_trace", "browser_video", "download", "service_checkpoint", "other"]>;
            sensitivity: z.ZodLiteral<"restricted">;
            retention: z.ZodEnum<["ephemeral", "run", "audit", "checkpoint"]>;
            objectKey: z.ZodString;
            sizeBytes: z.ZodNumber;
            sha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
            contentType: z.ZodString;
            createdAt: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            createdAt: string;
            sizeBytes: number;
            artifactId: string & z.BRAND<"ArtifactId">;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        }, {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            createdAt: string;
            sizeBytes: number;
            artifactId: string;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        }>, {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            createdAt: string;
            sizeBytes: number;
            artifactId: string & z.BRAND<"ArtifactId">;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        }, {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            createdAt: string;
            sizeBytes: number;
            artifactId: string;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        workerId: string & z.BRAND<"WorkerId">;
        leaseId: string & z.BRAND<"LeaseId">;
        fenceToken: string & z.BRAND<"FenceToken">;
        manifest: {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            createdAt: string;
            sizeBytes: number;
            artifactId: string & z.BRAND<"ArtifactId">;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        };
    }, {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        workerId: string;
        leaseId: string;
        fenceToken: string;
        manifest: {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            createdAt: string;
            sizeBytes: number;
            artifactId: string;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        };
    }>, {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        workerId: string & z.BRAND<"WorkerId">;
        leaseId: string & z.BRAND<"LeaseId">;
        fenceToken: string & z.BRAND<"FenceToken">;
        manifest: {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            createdAt: string;
            sizeBytes: number;
            artifactId: string & z.BRAND<"ArtifactId">;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        };
    }, {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        workerId: string;
        leaseId: string;
        fenceToken: string;
        manifest: {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            createdAt: string;
            sizeBytes: number;
            artifactId: string;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        };
    }>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    issuedAt: z.ZodString;
    nonce: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        workerId: string & z.BRAND<"WorkerId">;
        leaseId: string & z.BRAND<"LeaseId">;
        fenceToken: string & z.BRAND<"FenceToken">;
        manifest: {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            createdAt: string;
            sizeBytes: number;
            artifactId: string & z.BRAND<"ArtifactId">;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        };
    };
}, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        workerId: string;
        leaseId: string;
        fenceToken: string;
        manifest: {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            createdAt: string;
            sizeBytes: number;
            artifactId: string;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        };
    };
}>, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        workerId: string & z.BRAND<"WorkerId">;
        leaseId: string & z.BRAND<"LeaseId">;
        fenceToken: string & z.BRAND<"FenceToken">;
        manifest: {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            createdAt: string;
            sizeBytes: number;
            artifactId: string & z.BRAND<"ArtifactId">;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        };
    };
}, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "worker_run";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        workerId: string;
        leaseId: string;
        fenceToken: string;
        manifest: {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            createdAt: string;
            sizeBytes: number;
            artifactId: string;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        };
    };
}>;
export type ArtifactCommitOperationRequestV1 = z.infer<typeof artifactCommitOperationRequestV1Schema>;
export declare const ARTIFACT_COMMIT_OUTCOMES: readonly ["committed", "rejected"];
export declare const artifactCommitOperationResponseV1Schema: z.ZodEffects<z.ZodDiscriminatedUnion<"outcome", [z.ZodObject<{
    outcome: z.ZodLiteral<"committed">;
    artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
    versionNumber: z.ZodNumber;
    committedAt: z.ZodString;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    serverTime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    artifactId: string & z.BRAND<"ArtifactId">;
    correlationId: string;
    serverTime: string;
    outcome: "committed";
    versionNumber: number;
    committedAt: string;
}, {
    protocolVersion: 1;
    artifactId: string;
    correlationId: string;
    serverTime: string;
    outcome: "committed";
    versionNumber: number;
    committedAt: string;
}>, z.ZodObject<{
    outcome: z.ZodLiteral<"rejected">;
    reason: z.ZodEnum<["malformed", "unauthorized", "incompatible_protocol", "incompatible_capability", "incompatible_policy", "stale_fence", "sequence_gap", "target_revoked", "event_hash_mismatch", "throttled", "payload_too_large", "attempt_terminal", "internal_unavailable"]>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    serverTime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}, {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}>]>, {
    protocolVersion: 1;
    artifactId: string & z.BRAND<"ArtifactId">;
    correlationId: string;
    serverTime: string;
    outcome: "committed";
    versionNumber: number;
    committedAt: string;
} | {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}, {
    protocolVersion: 1;
    artifactId: string;
    correlationId: string;
    serverTime: string;
    outcome: "committed";
    versionNumber: number;
    committedAt: string;
} | {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}>;
export type ArtifactCommitOperationResponseV1 = z.infer<typeof artifactCommitOperationResponseV1Schema>;
export declare const quarantineGrantOperationRequestV1Schema: z.ZodEffects<z.ZodObject<{
    audience: z.ZodLiteral<"device_session">;
    idempotencyKey: z.ZodString;
    body: z.ZodEffects<z.ZodObject<{
        protocolVersion: z.ZodLiteral<1>;
        workerId: z.ZodBranded<z.ZodString, "WorkerId">;
        targetId: z.ZodBranded<z.ZodString, "TargetId">;
        deviceGeneration: z.ZodNumber;
        organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
        companyId: z.ZodBranded<z.ZodString, "CompanyId">;
        jobId: z.ZodBranded<z.ZodString, "JobId">;
        attempt: z.ZodNumber;
        observedLeaseId: z.ZodBranded<z.ZodString, "LeaseId">;
        observedFenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
        reason: z.ZodEnum<["stale_fence", "late_output", "hash_mismatch", "wrong_prefix", "size_mismatch", "unknown_artifact", "corrupt_checkpoint"]>;
        artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
        expectedObjectKey: z.ZodString;
        expectedSha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
        sizeBytes: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        workerId: string & z.BRAND<"WorkerId">;
        sizeBytes: number;
        artifactId: string & z.BRAND<"ArtifactId">;
        expectedObjectKey: string;
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        targetId: string & z.BRAND<"TargetId">;
        deviceGeneration: number;
        observedLeaseId: string & z.BRAND<"LeaseId">;
        observedFenceToken: string & z.BRAND<"FenceToken">;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
    }, {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        workerId: string;
        sizeBytes: number;
        artifactId: string;
        expectedObjectKey: string;
        expectedSha256: string;
        targetId: string;
        deviceGeneration: number;
        observedLeaseId: string;
        observedFenceToken: string;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
    }>, {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        workerId: string & z.BRAND<"WorkerId">;
        sizeBytes: number;
        artifactId: string & z.BRAND<"ArtifactId">;
        expectedObjectKey: string;
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        targetId: string & z.BRAND<"TargetId">;
        deviceGeneration: number;
        observedLeaseId: string & z.BRAND<"LeaseId">;
        observedFenceToken: string & z.BRAND<"FenceToken">;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
    }, {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        workerId: string;
        sizeBytes: number;
        artifactId: string;
        expectedObjectKey: string;
        expectedSha256: string;
        targetId: string;
        deviceGeneration: number;
        observedLeaseId: string;
        observedFenceToken: string;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
    }>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    issuedAt: z.ZodString;
    nonce: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "device_session";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        workerId: string & z.BRAND<"WorkerId">;
        sizeBytes: number;
        artifactId: string & z.BRAND<"ArtifactId">;
        expectedObjectKey: string;
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        targetId: string & z.BRAND<"TargetId">;
        deviceGeneration: number;
        observedLeaseId: string & z.BRAND<"LeaseId">;
        observedFenceToken: string & z.BRAND<"FenceToken">;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
    };
}, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "device_session";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        workerId: string;
        sizeBytes: number;
        artifactId: string;
        expectedObjectKey: string;
        expectedSha256: string;
        targetId: string;
        deviceGeneration: number;
        observedLeaseId: string;
        observedFenceToken: string;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
    };
}>, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "device_session";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        workerId: string & z.BRAND<"WorkerId">;
        sizeBytes: number;
        artifactId: string & z.BRAND<"ArtifactId">;
        expectedObjectKey: string;
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        targetId: string & z.BRAND<"TargetId">;
        deviceGeneration: number;
        observedLeaseId: string & z.BRAND<"LeaseId">;
        observedFenceToken: string & z.BRAND<"FenceToken">;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
    };
}, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "device_session";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        workerId: string;
        sizeBytes: number;
        artifactId: string;
        expectedObjectKey: string;
        expectedSha256: string;
        targetId: string;
        deviceGeneration: number;
        observedLeaseId: string;
        observedFenceToken: string;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
    };
}>;
export type QuarantineGrantOperationRequestV1 = z.infer<typeof quarantineGrantOperationRequestV1Schema>;
export declare const quarantineGrantOperationResponseV1Schema: z.ZodEffects<z.ZodDiscriminatedUnion<"outcome", [z.ZodObject<{
    outcome: z.ZodLiteral<"quarantine_upload_granted">;
    grant: z.ZodEffects<z.ZodObject<{
        protocolVersion: z.ZodLiteral<1>;
        operation: z.ZodLiteral<"quarantine_upload">;
        artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
        method: z.ZodLiteral<"PUT">;
        url: z.ZodString;
        headers: z.ZodRecord<z.ZodString, z.ZodString>;
        issuedAt: z.ZodString;
        expiresAt: z.ZodString;
        maxBytes: z.ZodNumber;
        expectedSha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
        quarantineObjectKey: z.ZodString;
        redaction: z.ZodLiteral<"secret">;
    }, "strict", z.ZodTypeAny, {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string & z.BRAND<"ArtifactId">;
        url: string;
        headers: Record<string, string>;
        operation: "quarantine_upload";
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        maxBytes: number;
        method: "PUT";
        issuedAt: string;
        redaction: "secret";
        quarantineObjectKey: string;
    }, {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string;
        url: string;
        headers: Record<string, string>;
        operation: "quarantine_upload";
        expectedSha256: string;
        maxBytes: number;
        method: "PUT";
        issuedAt: string;
        redaction: "secret";
        quarantineObjectKey: string;
    }>, {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string & z.BRAND<"ArtifactId">;
        url: string;
        headers: Record<string, string>;
        operation: "quarantine_upload";
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        maxBytes: number;
        method: "PUT";
        issuedAt: string;
        redaction: "secret";
        quarantineObjectKey: string;
    }, {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string;
        url: string;
        headers: Record<string, string>;
        operation: "quarantine_upload";
        expectedSha256: string;
        maxBytes: number;
        method: "PUT";
        issuedAt: string;
        redaction: "secret";
        quarantineObjectKey: string;
    }>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    serverTime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "quarantine_upload_granted";
    grant: {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string & z.BRAND<"ArtifactId">;
        url: string;
        headers: Record<string, string>;
        operation: "quarantine_upload";
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        maxBytes: number;
        method: "PUT";
        issuedAt: string;
        redaction: "secret";
        quarantineObjectKey: string;
    };
}, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "quarantine_upload_granted";
    grant: {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string;
        url: string;
        headers: Record<string, string>;
        operation: "quarantine_upload";
        expectedSha256: string;
        maxBytes: number;
        method: "PUT";
        issuedAt: string;
        redaction: "secret";
        quarantineObjectKey: string;
    };
}>, z.ZodObject<{
    outcome: z.ZodLiteral<"rejected">;
    reason: z.ZodEnum<["malformed", "unauthorized", "incompatible_protocol", "incompatible_capability", "incompatible_policy", "stale_fence", "sequence_gap", "target_revoked", "event_hash_mismatch", "throttled", "payload_too_large", "attempt_terminal", "internal_unavailable"]>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    serverTime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}, {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}>]>, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "quarantine_upload_granted";
    grant: {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string & z.BRAND<"ArtifactId">;
        url: string;
        headers: Record<string, string>;
        operation: "quarantine_upload";
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        maxBytes: number;
        method: "PUT";
        issuedAt: string;
        redaction: "secret";
        quarantineObjectKey: string;
    };
} | {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "quarantine_upload_granted";
    grant: {
        protocolVersion: 1;
        expiresAt: string;
        artifactId: string;
        url: string;
        headers: Record<string, string>;
        operation: "quarantine_upload";
        expectedSha256: string;
        maxBytes: number;
        method: "PUT";
        issuedAt: string;
        redaction: "secret";
        quarantineObjectKey: string;
    };
} | {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}>;
export type QuarantineGrantOperationResponseV1 = z.infer<typeof quarantineGrantOperationResponseV1Schema>;
export declare const quarantineFinalizeOperationRequestV1Schema: z.ZodEffects<z.ZodObject<{
    audience: z.ZodLiteral<"device_session">;
    idempotencyKey: z.ZodString;
    body: z.ZodEffects<z.ZodObject<{
        protocolVersion: z.ZodLiteral<1>;
        workerId: z.ZodBranded<z.ZodString, "WorkerId">;
        targetId: z.ZodBranded<z.ZodString, "TargetId">;
        deviceGeneration: z.ZodNumber;
        organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
        companyId: z.ZodBranded<z.ZodString, "CompanyId">;
        jobId: z.ZodBranded<z.ZodString, "JobId">;
        attempt: z.ZodNumber;
        observedLeaseId: z.ZodBranded<z.ZodString, "LeaseId">;
        observedFenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
        reason: z.ZodEnum<["stale_fence", "late_output", "hash_mismatch", "wrong_prefix", "size_mismatch", "unknown_artifact", "corrupt_checkpoint"]>;
        artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
        quarantineObjectKey: z.ZodString;
        expectedSha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
        sizeBytes: z.ZodNumber;
        manifest: z.ZodEffects<z.ZodObject<{
            protocolVersion: z.ZodLiteral<1>;
            organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
            companyId: z.ZodBranded<z.ZodString, "CompanyId">;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
            kind: z.ZodEnum<["workspace_snapshot", "workspace_patch", "log", "screenshot", "dom_snapshot", "browser_cookie_state", "browser_storage_state", "playwright_trace", "browser_video", "download", "service_checkpoint", "other"]>;
            sensitivity: z.ZodLiteral<"restricted">;
            retention: z.ZodEnum<["ephemeral", "run", "audit", "checkpoint"]>;
            objectKey: z.ZodString;
            sizeBytes: z.ZodNumber;
            sha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
            contentType: z.ZodString;
            createdAt: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            createdAt: string;
            sizeBytes: number;
            artifactId: string & z.BRAND<"ArtifactId">;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        }, {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            createdAt: string;
            sizeBytes: number;
            artifactId: string;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        }>, {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            createdAt: string;
            sizeBytes: number;
            artifactId: string & z.BRAND<"ArtifactId">;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        }, {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            createdAt: string;
            sizeBytes: number;
            artifactId: string;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        workerId: string & z.BRAND<"WorkerId">;
        sizeBytes: number;
        artifactId: string & z.BRAND<"ArtifactId">;
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        manifest: {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            createdAt: string;
            sizeBytes: number;
            artifactId: string & z.BRAND<"ArtifactId">;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        };
        targetId: string & z.BRAND<"TargetId">;
        deviceGeneration: number;
        observedLeaseId: string & z.BRAND<"LeaseId">;
        observedFenceToken: string & z.BRAND<"FenceToken">;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
        quarantineObjectKey: string;
    }, {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        workerId: string;
        sizeBytes: number;
        artifactId: string;
        expectedSha256: string;
        manifest: {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            createdAt: string;
            sizeBytes: number;
            artifactId: string;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        };
        targetId: string;
        deviceGeneration: number;
        observedLeaseId: string;
        observedFenceToken: string;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
        quarantineObjectKey: string;
    }>, {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        workerId: string & z.BRAND<"WorkerId">;
        sizeBytes: number;
        artifactId: string & z.BRAND<"ArtifactId">;
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        manifest: {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            createdAt: string;
            sizeBytes: number;
            artifactId: string & z.BRAND<"ArtifactId">;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        };
        targetId: string & z.BRAND<"TargetId">;
        deviceGeneration: number;
        observedLeaseId: string & z.BRAND<"LeaseId">;
        observedFenceToken: string & z.BRAND<"FenceToken">;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
        quarantineObjectKey: string;
    }, {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        workerId: string;
        sizeBytes: number;
        artifactId: string;
        expectedSha256: string;
        manifest: {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            createdAt: string;
            sizeBytes: number;
            artifactId: string;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        };
        targetId: string;
        deviceGeneration: number;
        observedLeaseId: string;
        observedFenceToken: string;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
        quarantineObjectKey: string;
    }>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    issuedAt: z.ZodString;
    nonce: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "device_session";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        workerId: string & z.BRAND<"WorkerId">;
        sizeBytes: number;
        artifactId: string & z.BRAND<"ArtifactId">;
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        manifest: {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            createdAt: string;
            sizeBytes: number;
            artifactId: string & z.BRAND<"ArtifactId">;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        };
        targetId: string & z.BRAND<"TargetId">;
        deviceGeneration: number;
        observedLeaseId: string & z.BRAND<"LeaseId">;
        observedFenceToken: string & z.BRAND<"FenceToken">;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
        quarantineObjectKey: string;
    };
}, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "device_session";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        workerId: string;
        sizeBytes: number;
        artifactId: string;
        expectedSha256: string;
        manifest: {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            createdAt: string;
            sizeBytes: number;
            artifactId: string;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        };
        targetId: string;
        deviceGeneration: number;
        observedLeaseId: string;
        observedFenceToken: string;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
        quarantineObjectKey: string;
    };
}>, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "device_session";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        workerId: string & z.BRAND<"WorkerId">;
        sizeBytes: number;
        artifactId: string & z.BRAND<"ArtifactId">;
        expectedSha256: string & z.BRAND<"Sha256Digest">;
        manifest: {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string & z.BRAND<"Sha256Digest">;
            protocolVersion: 1;
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            organizationId: string & z.BRAND<"OrganizationId">;
            companyId: string & z.BRAND<"CompanyId">;
            createdAt: string;
            sizeBytes: number;
            artifactId: string & z.BRAND<"ArtifactId">;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        };
        targetId: string & z.BRAND<"TargetId">;
        deviceGeneration: number;
        observedLeaseId: string & z.BRAND<"LeaseId">;
        observedFenceToken: string & z.BRAND<"FenceToken">;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
        quarantineObjectKey: string;
    };
}, {
    protocolVersion: 1;
    issuedAt: string;
    nonce: string;
    correlationId: string;
    audience: "device_session";
    idempotencyKey: string;
    body: {
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        workerId: string;
        sizeBytes: number;
        artifactId: string;
        expectedSha256: string;
        manifest: {
            kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
            sha256: string;
            protocolVersion: 1;
            jobId: string;
            attempt: number;
            organizationId: string;
            companyId: string;
            createdAt: string;
            sizeBytes: number;
            artifactId: string;
            sensitivity: "restricted";
            retention: "ephemeral" | "run" | "audit" | "checkpoint";
            objectKey: string;
            contentType: string;
        };
        targetId: string;
        deviceGeneration: number;
        observedLeaseId: string;
        observedFenceToken: string;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
        quarantineObjectKey: string;
    };
}>;
export type QuarantineFinalizeOperationRequestV1 = z.infer<typeof quarantineFinalizeOperationRequestV1Schema>;
export declare const quarantineFinalizeOperationResponseV1Schema: z.ZodEffects<z.ZodDiscriminatedUnion<"outcome", [z.ZodObject<{
    outcome: z.ZodLiteral<"quarantined">;
    receipt: z.ZodEffects<z.ZodObject<{
        protocolVersion: z.ZodLiteral<1>;
        receiptId: z.ZodString;
        quarantineObjectKey: z.ZodString;
        observed: z.ZodObject<{
            workerId: z.ZodBranded<z.ZodString, "WorkerId">;
            targetId: z.ZodBranded<z.ZodString, "TargetId">;
            deviceGeneration: z.ZodNumber;
            jobId: z.ZodBranded<z.ZodString, "JobId">;
            attempt: z.ZodNumber;
            leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
            fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
        }, "strict", z.ZodTypeAny, {
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            targetId: string & z.BRAND<"TargetId">;
            deviceGeneration: number;
        }, {
            jobId: string;
            attempt: number;
            workerId: string;
            leaseId: string;
            fenceToken: string;
            targetId: string;
            deviceGeneration: number;
        }>;
        artifact: z.ZodObject<{
            artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
            sha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
            sizeBytes: z.ZodNumber;
            sensitivity: z.ZodLiteral<"restricted">;
            provenance: z.ZodEnum<["tracked", "untracked", "generated"]>;
        }, "strict", z.ZodTypeAny, {
            sha256: string & z.BRAND<"Sha256Digest">;
            provenance: "tracked" | "untracked" | "generated";
            sizeBytes: number;
            artifactId: string & z.BRAND<"ArtifactId">;
            sensitivity: "restricted";
        }, {
            sha256: string;
            provenance: "tracked" | "untracked" | "generated";
            sizeBytes: number;
            artifactId: string;
            sensitivity: "restricted";
        }>;
        reason: z.ZodEnum<["stale_fence", "late_output", "hash_mismatch", "wrong_prefix", "size_mismatch", "unknown_artifact", "corrupt_checkpoint"]>;
        receivedAt: z.ZodString;
        disposition: z.ZodLiteral<"quarantined">;
    }, "strict", z.ZodTypeAny, {
        protocolVersion: 1;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
        quarantineObjectKey: string;
        receiptId: string;
        observed: {
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            targetId: string & z.BRAND<"TargetId">;
            deviceGeneration: number;
        };
        artifact: {
            sha256: string & z.BRAND<"Sha256Digest">;
            provenance: "tracked" | "untracked" | "generated";
            sizeBytes: number;
            artifactId: string & z.BRAND<"ArtifactId">;
            sensitivity: "restricted";
        };
        receivedAt: string;
        disposition: "quarantined";
    }, {
        protocolVersion: 1;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
        quarantineObjectKey: string;
        receiptId: string;
        observed: {
            jobId: string;
            attempt: number;
            workerId: string;
            leaseId: string;
            fenceToken: string;
            targetId: string;
            deviceGeneration: number;
        };
        artifact: {
            sha256: string;
            provenance: "tracked" | "untracked" | "generated";
            sizeBytes: number;
            artifactId: string;
            sensitivity: "restricted";
        };
        receivedAt: string;
        disposition: "quarantined";
    }>, {
        protocolVersion: 1;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
        quarantineObjectKey: string;
        receiptId: string;
        observed: {
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            targetId: string & z.BRAND<"TargetId">;
            deviceGeneration: number;
        };
        artifact: {
            sha256: string & z.BRAND<"Sha256Digest">;
            provenance: "tracked" | "untracked" | "generated";
            sizeBytes: number;
            artifactId: string & z.BRAND<"ArtifactId">;
            sensitivity: "restricted";
        };
        receivedAt: string;
        disposition: "quarantined";
    }, {
        protocolVersion: 1;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
        quarantineObjectKey: string;
        receiptId: string;
        observed: {
            jobId: string;
            attempt: number;
            workerId: string;
            leaseId: string;
            fenceToken: string;
            targetId: string;
            deviceGeneration: number;
        };
        artifact: {
            sha256: string;
            provenance: "tracked" | "untracked" | "generated";
            sizeBytes: number;
            artifactId: string;
            sensitivity: "restricted";
        };
        receivedAt: string;
        disposition: "quarantined";
    }>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    serverTime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "quarantined";
    receipt: {
        protocolVersion: 1;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
        quarantineObjectKey: string;
        receiptId: string;
        observed: {
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            targetId: string & z.BRAND<"TargetId">;
            deviceGeneration: number;
        };
        artifact: {
            sha256: string & z.BRAND<"Sha256Digest">;
            provenance: "tracked" | "untracked" | "generated";
            sizeBytes: number;
            artifactId: string & z.BRAND<"ArtifactId">;
            sensitivity: "restricted";
        };
        receivedAt: string;
        disposition: "quarantined";
    };
}, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "quarantined";
    receipt: {
        protocolVersion: 1;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
        quarantineObjectKey: string;
        receiptId: string;
        observed: {
            jobId: string;
            attempt: number;
            workerId: string;
            leaseId: string;
            fenceToken: string;
            targetId: string;
            deviceGeneration: number;
        };
        artifact: {
            sha256: string;
            provenance: "tracked" | "untracked" | "generated";
            sizeBytes: number;
            artifactId: string;
            sensitivity: "restricted";
        };
        receivedAt: string;
        disposition: "quarantined";
    };
}>, z.ZodObject<{
    outcome: z.ZodLiteral<"rejected">;
    reason: z.ZodEnum<["malformed", "unauthorized", "incompatible_protocol", "incompatible_capability", "incompatible_policy", "stale_fence", "sequence_gap", "target_revoked", "event_hash_mismatch", "throttled", "payload_too_large", "attempt_terminal", "internal_unavailable"]>;
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    serverTime: z.ZodString;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}, {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}>]>, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "quarantined";
    receipt: {
        protocolVersion: 1;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
        quarantineObjectKey: string;
        receiptId: string;
        observed: {
            jobId: string & z.BRAND<"JobId">;
            attempt: number;
            workerId: string & z.BRAND<"WorkerId">;
            leaseId: string & z.BRAND<"LeaseId">;
            fenceToken: string & z.BRAND<"FenceToken">;
            targetId: string & z.BRAND<"TargetId">;
            deviceGeneration: number;
        };
        artifact: {
            sha256: string & z.BRAND<"Sha256Digest">;
            provenance: "tracked" | "untracked" | "generated";
            sizeBytes: number;
            artifactId: string & z.BRAND<"ArtifactId">;
            sensitivity: "restricted";
        };
        receivedAt: string;
        disposition: "quarantined";
    };
} | {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}, {
    protocolVersion: 1;
    correlationId: string;
    serverTime: string;
    outcome: "quarantined";
    receipt: {
        protocolVersion: 1;
        reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
        quarantineObjectKey: string;
        receiptId: string;
        observed: {
            jobId: string;
            attempt: number;
            workerId: string;
            leaseId: string;
            fenceToken: string;
            targetId: string;
            deviceGeneration: number;
        };
        artifact: {
            sha256: string;
            provenance: "tracked" | "untracked" | "generated";
            sizeBytes: number;
            artifactId: string;
            sensitivity: "restricted";
        };
        receivedAt: string;
        disposition: "quarantined";
    };
} | {
    protocolVersion: 1;
    reason: "stale_fence" | "target_revoked" | "malformed" | "unauthorized" | "incompatible_protocol" | "incompatible_capability" | "incompatible_policy" | "sequence_gap" | "event_hash_mismatch" | "throttled" | "payload_too_large" | "attempt_terminal" | "internal_unavailable";
    correlationId: string;
    serverTime: string;
    outcome: "rejected";
}>;
export type QuarantineFinalizeOperationResponseV1 = z.infer<typeof quarantineFinalizeOperationResponseV1Schema>;
export declare const PRODUCT_APPROVAL_DECISIONS: readonly ["approved", "rejected", "expired"];
export declare const productApprovalDecisionSchema: z.ZodEnum<["approved", "rejected", "expired"]>;
export type ProductApprovalDecision = (typeof PRODUCT_APPROVAL_DECISIONS)[number];
export declare const governedActionRefSchema: z.ZodObject<{
    kind: z.ZodString;
    id: z.ZodString;
}, "strict", z.ZodTypeAny, {
    kind: string;
    id: string;
}, {
    kind: string;
    id: string;
}>;
export type GovernedActionRefV1 = z.infer<typeof governedActionRefSchema>;
/**
 * A durable product-approval result. It authorizes EXACTLY the bound
 * `governedActionRef` — it cannot authorize a different governed action. The
 * deciding principal is typed; the decision is versioned + idempotency-keyed so a
 * lost response can be re-delivered without re-approving.
 */
export declare const productApprovalResultV1Schema: z.ZodEffects<z.ZodObject<{
    approvalId: z.ZodString;
    approvalKind: z.ZodString;
    approvalVersion: z.ZodNumber;
    decision: z.ZodEnum<["approved", "rejected", "expired"]>;
    decidedBy: z.ZodObject<{
        principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
        principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
    }, "strict", z.ZodTypeAny, {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string & z.BRAND<"PrincipalId">;
    }, {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string;
    }>;
    decidedAt: z.ZodString;
    idempotencyKey: z.ZodString;
    governedActionRef: z.ZodObject<{
        kind: z.ZodString;
        id: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        kind: string;
        id: string;
    }, {
        kind: string;
        id: string;
    }>;
}, "strict", z.ZodTypeAny, {
    approvalId: string;
    idempotencyKey: string;
    approvalKind: string;
    approvalVersion: number;
    decision: "expired" | "rejected" | "approved";
    decidedBy: {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string & z.BRAND<"PrincipalId">;
    };
    decidedAt: string;
    governedActionRef: {
        kind: string;
        id: string;
    };
}, {
    approvalId: string;
    idempotencyKey: string;
    approvalKind: string;
    approvalVersion: number;
    decision: "expired" | "rejected" | "approved";
    decidedBy: {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string;
    };
    decidedAt: string;
    governedActionRef: {
        kind: string;
        id: string;
    };
}>, {
    approvalId: string;
    idempotencyKey: string;
    approvalKind: string;
    approvalVersion: number;
    decision: "expired" | "rejected" | "approved";
    decidedBy: {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string & z.BRAND<"PrincipalId">;
    };
    decidedAt: string;
    governedActionRef: {
        kind: string;
        id: string;
    };
}, {
    approvalId: string;
    idempotencyKey: string;
    approvalKind: string;
    approvalVersion: number;
    decision: "expired" | "rejected" | "approved";
    decidedBy: {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string;
    };
    decidedAt: string;
    governedActionRef: {
        kind: string;
        id: string;
    };
}>;
export type ProductApprovalResultV1 = z.infer<typeof productApprovalResultV1Schema>;
/** True iff `result` authorizes exactly `action` (same governed action kind+id). */
export declare function productApprovalAuthorizesActionV1(result: ProductApprovalResultV1, action: GovernedActionRefV1): boolean;
export declare const PERMISSION_DECISIONS: readonly ["allow_once", "allow_run", "allow_always", "deny", "expired", "cancelled"];
export declare const permissionDecisionSchema: z.ZodEnum<["allow_once", "allow_run", "allow_always", "deny", "expired", "cancelled"]>;
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];
export declare const WORK_QUESTION_OUTCOMES: readonly ["answered", "expired", "cancelled"];
export declare const workQuestionOutcomeSchema: z.ZodEnum<["answered", "expired", "cancelled"]>;
export type WorkQuestionOutcome = (typeof WORK_QUESTION_OUTCOMES)[number];
export declare const permissionRuntimeDecisionResultV1Schema: z.ZodObject<{
    timeoutPolicy: z.ZodEnum<["deny", "cancel_run", "park_run", "continue_with_default", "escalate"]>;
    decision: z.ZodEnum<["allow_once", "allow_run", "allow_always", "deny", "expired", "cancelled"]>;
    requestId: z.ZodString;
    nonce: z.ZodEffects<z.ZodString, string, string>;
    requestDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
    schemaVersion: z.ZodNumber;
    sourceRevision: z.ZodNumber;
    expiresAt: z.ZodString;
    decidedBy: z.ZodObject<{
        principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
        principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
    }, "strict", z.ZodTypeAny, {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string & z.BRAND<"PrincipalId">;
    }, {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string;
    }>;
    decidedAt: z.ZodString;
    idempotencyKey: z.ZodString;
    decisionKind: z.ZodLiteral<"permission">;
}, "strict", z.ZodTypeAny, {
    schemaVersion: number;
    expiresAt: string;
    decisionKind: "permission";
    timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
    requestId: string;
    nonce: string;
    requestDigest: string & z.BRAND<"Sha256Digest">;
    sourceRevision: number;
    idempotencyKey: string;
    decision: "deny" | "allow_once" | "allow_run" | "cancelled" | "expired" | "allow_always";
    decidedBy: {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string & z.BRAND<"PrincipalId">;
    };
    decidedAt: string;
}, {
    schemaVersion: number;
    expiresAt: string;
    decisionKind: "permission";
    timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
    requestId: string;
    nonce: string;
    requestDigest: string;
    sourceRevision: number;
    idempotencyKey: string;
    decision: "deny" | "allow_once" | "allow_run" | "cancelled" | "expired" | "allow_always";
    decidedBy: {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string;
    };
    decidedAt: string;
}>;
export type PermissionRuntimeDecisionResultV1 = z.infer<typeof permissionRuntimeDecisionResultV1Schema>;
export declare const workQuestionRuntimeDecisionResultV1Schema: z.ZodObject<{
    timeoutPolicy: z.ZodEnum<["cancel_run", "park_run", "continue_with_default", "escalate"]>;
    outcome: z.ZodEnum<["answered", "expired", "cancelled"]>;
    answer: z.ZodNullable<z.ZodEffects<z.ZodUnknown, unknown, unknown>>;
    requestId: z.ZodString;
    nonce: z.ZodEffects<z.ZodString, string, string>;
    requestDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
    schemaVersion: z.ZodNumber;
    sourceRevision: z.ZodNumber;
    expiresAt: z.ZodString;
    decidedBy: z.ZodObject<{
        principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
        principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
    }, "strict", z.ZodTypeAny, {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string & z.BRAND<"PrincipalId">;
    }, {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string;
    }>;
    decidedAt: z.ZodString;
    idempotencyKey: z.ZodString;
    decisionKind: z.ZodLiteral<"work_question">;
}, "strict", z.ZodTypeAny, {
    schemaVersion: number;
    expiresAt: string;
    decisionKind: "work_question";
    timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
    requestId: string;
    nonce: string;
    requestDigest: string & z.BRAND<"Sha256Digest">;
    sourceRevision: number;
    idempotencyKey: string;
    outcome: "cancelled" | "expired" | "answered";
    decidedBy: {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string & z.BRAND<"PrincipalId">;
    };
    decidedAt: string;
    answer?: unknown;
}, {
    schemaVersion: number;
    expiresAt: string;
    decisionKind: "work_question";
    timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
    requestId: string;
    nonce: string;
    requestDigest: string;
    sourceRevision: number;
    idempotencyKey: string;
    outcome: "cancelled" | "expired" | "answered";
    decidedBy: {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string;
    };
    decidedAt: string;
    answer?: unknown;
}>;
export type WorkQuestionRuntimeDecisionResultV1 = z.infer<typeof workQuestionRuntimeDecisionResultV1Schema>;
/**
 * The strict runtime-decision result union answering a previously accepted
 * `runtime_decision_requested` event. Cross-kind fields are rejected by
 * `.strict()`; a permission decision is exactly one of the six permission
 * literals; a work-question answer is bounded (≤16 KiB canonical, ≤8 levels) and
 * required only for `answered` (the answer rule sits on the union `superRefine`
 * because `discriminatedUnion` members must be bare `ZodObject`s).
 */
export declare const runtimeDecisionResultV1Schema: z.ZodEffects<z.ZodDiscriminatedUnion<"decisionKind", [z.ZodObject<{
    timeoutPolicy: z.ZodEnum<["deny", "cancel_run", "park_run", "continue_with_default", "escalate"]>;
    decision: z.ZodEnum<["allow_once", "allow_run", "allow_always", "deny", "expired", "cancelled"]>;
    requestId: z.ZodString;
    nonce: z.ZodEffects<z.ZodString, string, string>;
    requestDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
    schemaVersion: z.ZodNumber;
    sourceRevision: z.ZodNumber;
    expiresAt: z.ZodString;
    decidedBy: z.ZodObject<{
        principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
        principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
    }, "strict", z.ZodTypeAny, {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string & z.BRAND<"PrincipalId">;
    }, {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string;
    }>;
    decidedAt: z.ZodString;
    idempotencyKey: z.ZodString;
    decisionKind: z.ZodLiteral<"permission">;
}, "strict", z.ZodTypeAny, {
    schemaVersion: number;
    expiresAt: string;
    decisionKind: "permission";
    timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
    requestId: string;
    nonce: string;
    requestDigest: string & z.BRAND<"Sha256Digest">;
    sourceRevision: number;
    idempotencyKey: string;
    decision: "deny" | "allow_once" | "allow_run" | "cancelled" | "expired" | "allow_always";
    decidedBy: {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string & z.BRAND<"PrincipalId">;
    };
    decidedAt: string;
}, {
    schemaVersion: number;
    expiresAt: string;
    decisionKind: "permission";
    timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
    requestId: string;
    nonce: string;
    requestDigest: string;
    sourceRevision: number;
    idempotencyKey: string;
    decision: "deny" | "allow_once" | "allow_run" | "cancelled" | "expired" | "allow_always";
    decidedBy: {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string;
    };
    decidedAt: string;
}>, z.ZodObject<{
    timeoutPolicy: z.ZodEnum<["cancel_run", "park_run", "continue_with_default", "escalate"]>;
    outcome: z.ZodEnum<["answered", "expired", "cancelled"]>;
    answer: z.ZodNullable<z.ZodEffects<z.ZodUnknown, unknown, unknown>>;
    requestId: z.ZodString;
    nonce: z.ZodEffects<z.ZodString, string, string>;
    requestDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
    schemaVersion: z.ZodNumber;
    sourceRevision: z.ZodNumber;
    expiresAt: z.ZodString;
    decidedBy: z.ZodObject<{
        principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
        principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
    }, "strict", z.ZodTypeAny, {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string & z.BRAND<"PrincipalId">;
    }, {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string;
    }>;
    decidedAt: z.ZodString;
    idempotencyKey: z.ZodString;
    decisionKind: z.ZodLiteral<"work_question">;
}, "strict", z.ZodTypeAny, {
    schemaVersion: number;
    expiresAt: string;
    decisionKind: "work_question";
    timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
    requestId: string;
    nonce: string;
    requestDigest: string & z.BRAND<"Sha256Digest">;
    sourceRevision: number;
    idempotencyKey: string;
    outcome: "cancelled" | "expired" | "answered";
    decidedBy: {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string & z.BRAND<"PrincipalId">;
    };
    decidedAt: string;
    answer?: unknown;
}, {
    schemaVersion: number;
    expiresAt: string;
    decisionKind: "work_question";
    timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
    requestId: string;
    nonce: string;
    requestDigest: string;
    sourceRevision: number;
    idempotencyKey: string;
    outcome: "cancelled" | "expired" | "answered";
    decidedBy: {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string;
    };
    decidedAt: string;
    answer?: unknown;
}>]>, {
    schemaVersion: number;
    expiresAt: string;
    decisionKind: "permission";
    timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
    requestId: string;
    nonce: string;
    requestDigest: string & z.BRAND<"Sha256Digest">;
    sourceRevision: number;
    idempotencyKey: string;
    decision: "deny" | "allow_once" | "allow_run" | "cancelled" | "expired" | "allow_always";
    decidedBy: {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string & z.BRAND<"PrincipalId">;
    };
    decidedAt: string;
} | {
    schemaVersion: number;
    expiresAt: string;
    decisionKind: "work_question";
    timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
    requestId: string;
    nonce: string;
    requestDigest: string & z.BRAND<"Sha256Digest">;
    sourceRevision: number;
    idempotencyKey: string;
    outcome: "cancelled" | "expired" | "answered";
    decidedBy: {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string & z.BRAND<"PrincipalId">;
    };
    decidedAt: string;
    answer?: unknown;
}, {
    schemaVersion: number;
    expiresAt: string;
    decisionKind: "permission";
    timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
    requestId: string;
    nonce: string;
    requestDigest: string;
    sourceRevision: number;
    idempotencyKey: string;
    decision: "deny" | "allow_once" | "allow_run" | "cancelled" | "expired" | "allow_always";
    decidedBy: {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string;
    };
    decidedAt: string;
} | {
    schemaVersion: number;
    expiresAt: string;
    decisionKind: "work_question";
    timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
    requestId: string;
    nonce: string;
    requestDigest: string;
    sourceRevision: number;
    idempotencyKey: string;
    outcome: "cancelled" | "expired" | "answered";
    decidedBy: {
        principalType: "user" | "agent" | "service" | "system";
        principalId: string;
    };
    decidedAt: string;
    answer?: unknown;
}>;
export type RuntimeDecisionResultV1 = z.infer<typeof runtimeDecisionResultV1Schema>;
/** Why a runtime-decision result failed to bind to its request (fail-closed). */
export declare const RUNTIME_DECISION_MATCH_REASONS: readonly ["missing_request", "kind_mismatch", "request_mismatch", "expired"];
export type RuntimeDecisionMatchReason = (typeof RUNTIME_DECISION_MATCH_REASONS)[number];
export type RuntimeDecisionMatchResultV1 = {
    ok: true;
} | {
    ok: false;
    reason: RuntimeDecisionMatchReason;
};
/**
 * Bind a runtime-decision result to the previously accepted request. Fails closed
 * on: a missing request, a cross-kind pairing, any echoed-field mismatch
 * (requestId / nonce / requestDigest / schemaVersion / sourceRevision / expiry /
 * timeoutPolicy), or a late positive decision made after expiry. The worker may
 * REQUEST a decision but never mints the authoritative result, so this pairing is
 * evaluated by the control plane, never self-asserted.
 */
export declare function matchRuntimeDecisionResultToRequestV1(request: RuntimeDecisionRequestV1 | null | undefined, result: RuntimeDecisionResultV1): RuntimeDecisionMatchResultV1;
export declare const CONTROL_COMMAND_KINDS: readonly ["cancel", "product_approval_result", "runtime_decision_result", "checkpoint", "graceful_stop", "drain"];
/**
 * A durable, sequenced control command issued on the control channel. Product
 * approvals and runtime decisions are SEPARATE variants and are NOT conflatable.
 * Controls are never worker-creatable: the audience literal is `control_channel`
 * and the worker only ACKs.
 */
export declare const controlCommandV1Schema: z.ZodEffects<z.ZodDiscriminatedUnion<"commandKind", [z.ZodObject<{
    commandKind: z.ZodLiteral<"cancel">;
    reason: z.ZodString;
    graceful: z.ZodBoolean;
    organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
    companyId: z.ZodBranded<z.ZodString, "CompanyId">;
    workerId: z.ZodBranded<z.ZodString, "WorkerId">;
    jobId: z.ZodBranded<z.ZodString, "JobId">;
    attempt: z.ZodNumber;
    leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
    fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
    protocolVersion: z.ZodLiteral<1>;
    audience: z.ZodLiteral<"control_channel">;
    commandId: z.ZodString;
    commandSeq: z.ZodNumber;
    idempotencyKey: z.ZodString;
    issuedAt: z.ZodString;
    nonce: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    issuedAt: string;
    reason: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "cancel";
    graceful: boolean;
    commandId: string;
    commandSeq: number;
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    issuedAt: string;
    reason: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "cancel";
    graceful: boolean;
    commandId: string;
    commandSeq: number;
}>, z.ZodObject<{
    commandKind: z.ZodLiteral<"product_approval_result">;
    result: z.ZodEffects<z.ZodObject<{
        approvalId: z.ZodString;
        approvalKind: z.ZodString;
        approvalVersion: z.ZodNumber;
        decision: z.ZodEnum<["approved", "rejected", "expired"]>;
        decidedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        decidedAt: z.ZodString;
        idempotencyKey: z.ZodString;
        governedActionRef: z.ZodObject<{
            kind: z.ZodString;
            id: z.ZodString;
        }, "strict", z.ZodTypeAny, {
            kind: string;
            id: string;
        }, {
            kind: string;
            id: string;
        }>;
    }, "strict", z.ZodTypeAny, {
        approvalId: string;
        idempotencyKey: string;
        approvalKind: string;
        approvalVersion: number;
        decision: "expired" | "rejected" | "approved";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        decidedAt: string;
        governedActionRef: {
            kind: string;
            id: string;
        };
    }, {
        approvalId: string;
        idempotencyKey: string;
        approvalKind: string;
        approvalVersion: number;
        decision: "expired" | "rejected" | "approved";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        decidedAt: string;
        governedActionRef: {
            kind: string;
            id: string;
        };
    }>, {
        approvalId: string;
        idempotencyKey: string;
        approvalKind: string;
        approvalVersion: number;
        decision: "expired" | "rejected" | "approved";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        decidedAt: string;
        governedActionRef: {
            kind: string;
            id: string;
        };
    }, {
        approvalId: string;
        idempotencyKey: string;
        approvalKind: string;
        approvalVersion: number;
        decision: "expired" | "rejected" | "approved";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        decidedAt: string;
        governedActionRef: {
            kind: string;
            id: string;
        };
    }>;
    organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
    companyId: z.ZodBranded<z.ZodString, "CompanyId">;
    workerId: z.ZodBranded<z.ZodString, "WorkerId">;
    jobId: z.ZodBranded<z.ZodString, "JobId">;
    attempt: z.ZodNumber;
    leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
    fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
    protocolVersion: z.ZodLiteral<1>;
    audience: z.ZodLiteral<"control_channel">;
    commandId: z.ZodString;
    commandSeq: z.ZodNumber;
    idempotencyKey: z.ZodString;
    issuedAt: z.ZodString;
    nonce: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    issuedAt: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "product_approval_result";
    commandId: string;
    commandSeq: number;
    result: {
        approvalId: string;
        idempotencyKey: string;
        approvalKind: string;
        approvalVersion: number;
        decision: "expired" | "rejected" | "approved";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        decidedAt: string;
        governedActionRef: {
            kind: string;
            id: string;
        };
    };
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    issuedAt: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "product_approval_result";
    commandId: string;
    commandSeq: number;
    result: {
        approvalId: string;
        idempotencyKey: string;
        approvalKind: string;
        approvalVersion: number;
        decision: "expired" | "rejected" | "approved";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        decidedAt: string;
        governedActionRef: {
            kind: string;
            id: string;
        };
    };
}>, z.ZodObject<{
    commandKind: z.ZodLiteral<"runtime_decision_result">;
    result: z.ZodEffects<z.ZodDiscriminatedUnion<"decisionKind", [z.ZodObject<{
        timeoutPolicy: z.ZodEnum<["deny", "cancel_run", "park_run", "continue_with_default", "escalate"]>;
        decision: z.ZodEnum<["allow_once", "allow_run", "allow_always", "deny", "expired", "cancelled"]>;
        requestId: z.ZodString;
        nonce: z.ZodEffects<z.ZodString, string, string>;
        requestDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
        schemaVersion: z.ZodNumber;
        sourceRevision: z.ZodNumber;
        expiresAt: z.ZodString;
        decidedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        decidedAt: z.ZodString;
        idempotencyKey: z.ZodString;
        decisionKind: z.ZodLiteral<"permission">;
    }, "strict", z.ZodTypeAny, {
        schemaVersion: number;
        expiresAt: string;
        decisionKind: "permission";
        timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
        requestId: string;
        nonce: string;
        requestDigest: string & z.BRAND<"Sha256Digest">;
        sourceRevision: number;
        idempotencyKey: string;
        decision: "deny" | "allow_once" | "allow_run" | "cancelled" | "expired" | "allow_always";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        decidedAt: string;
    }, {
        schemaVersion: number;
        expiresAt: string;
        decisionKind: "permission";
        timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
        requestId: string;
        nonce: string;
        requestDigest: string;
        sourceRevision: number;
        idempotencyKey: string;
        decision: "deny" | "allow_once" | "allow_run" | "cancelled" | "expired" | "allow_always";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        decidedAt: string;
    }>, z.ZodObject<{
        timeoutPolicy: z.ZodEnum<["cancel_run", "park_run", "continue_with_default", "escalate"]>;
        outcome: z.ZodEnum<["answered", "expired", "cancelled"]>;
        answer: z.ZodNullable<z.ZodEffects<z.ZodUnknown, unknown, unknown>>;
        requestId: z.ZodString;
        nonce: z.ZodEffects<z.ZodString, string, string>;
        requestDigest: z.ZodBranded<z.ZodString, "Sha256Digest">;
        schemaVersion: z.ZodNumber;
        sourceRevision: z.ZodNumber;
        expiresAt: z.ZodString;
        decidedBy: z.ZodObject<{
            principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
            principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
        }, "strict", z.ZodTypeAny, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        }, {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        }>;
        decidedAt: z.ZodString;
        idempotencyKey: z.ZodString;
        decisionKind: z.ZodLiteral<"work_question">;
    }, "strict", z.ZodTypeAny, {
        schemaVersion: number;
        expiresAt: string;
        decisionKind: "work_question";
        timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
        requestId: string;
        nonce: string;
        requestDigest: string & z.BRAND<"Sha256Digest">;
        sourceRevision: number;
        idempotencyKey: string;
        outcome: "cancelled" | "expired" | "answered";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        decidedAt: string;
        answer?: unknown;
    }, {
        schemaVersion: number;
        expiresAt: string;
        decisionKind: "work_question";
        timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
        requestId: string;
        nonce: string;
        requestDigest: string;
        sourceRevision: number;
        idempotencyKey: string;
        outcome: "cancelled" | "expired" | "answered";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        decidedAt: string;
        answer?: unknown;
    }>]>, {
        schemaVersion: number;
        expiresAt: string;
        decisionKind: "permission";
        timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
        requestId: string;
        nonce: string;
        requestDigest: string & z.BRAND<"Sha256Digest">;
        sourceRevision: number;
        idempotencyKey: string;
        decision: "deny" | "allow_once" | "allow_run" | "cancelled" | "expired" | "allow_always";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        decidedAt: string;
    } | {
        schemaVersion: number;
        expiresAt: string;
        decisionKind: "work_question";
        timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
        requestId: string;
        nonce: string;
        requestDigest: string & z.BRAND<"Sha256Digest">;
        sourceRevision: number;
        idempotencyKey: string;
        outcome: "cancelled" | "expired" | "answered";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        decidedAt: string;
        answer?: unknown;
    }, {
        schemaVersion: number;
        expiresAt: string;
        decisionKind: "permission";
        timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
        requestId: string;
        nonce: string;
        requestDigest: string;
        sourceRevision: number;
        idempotencyKey: string;
        decision: "deny" | "allow_once" | "allow_run" | "cancelled" | "expired" | "allow_always";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        decidedAt: string;
    } | {
        schemaVersion: number;
        expiresAt: string;
        decisionKind: "work_question";
        timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
        requestId: string;
        nonce: string;
        requestDigest: string;
        sourceRevision: number;
        idempotencyKey: string;
        outcome: "cancelled" | "expired" | "answered";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        decidedAt: string;
        answer?: unknown;
    }>;
    organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
    companyId: z.ZodBranded<z.ZodString, "CompanyId">;
    workerId: z.ZodBranded<z.ZodString, "WorkerId">;
    jobId: z.ZodBranded<z.ZodString, "JobId">;
    attempt: z.ZodNumber;
    leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
    fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
    protocolVersion: z.ZodLiteral<1>;
    audience: z.ZodLiteral<"control_channel">;
    commandId: z.ZodString;
    commandSeq: z.ZodNumber;
    idempotencyKey: z.ZodString;
    issuedAt: z.ZodString;
    nonce: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    issuedAt: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "runtime_decision_result";
    commandId: string;
    commandSeq: number;
    result: {
        schemaVersion: number;
        expiresAt: string;
        decisionKind: "permission";
        timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
        requestId: string;
        nonce: string;
        requestDigest: string & z.BRAND<"Sha256Digest">;
        sourceRevision: number;
        idempotencyKey: string;
        decision: "deny" | "allow_once" | "allow_run" | "cancelled" | "expired" | "allow_always";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        decidedAt: string;
    } | {
        schemaVersion: number;
        expiresAt: string;
        decisionKind: "work_question";
        timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
        requestId: string;
        nonce: string;
        requestDigest: string & z.BRAND<"Sha256Digest">;
        sourceRevision: number;
        idempotencyKey: string;
        outcome: "cancelled" | "expired" | "answered";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        decidedAt: string;
        answer?: unknown;
    };
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    issuedAt: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "runtime_decision_result";
    commandId: string;
    commandSeq: number;
    result: {
        schemaVersion: number;
        expiresAt: string;
        decisionKind: "permission";
        timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
        requestId: string;
        nonce: string;
        requestDigest: string;
        sourceRevision: number;
        idempotencyKey: string;
        decision: "deny" | "allow_once" | "allow_run" | "cancelled" | "expired" | "allow_always";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        decidedAt: string;
    } | {
        schemaVersion: number;
        expiresAt: string;
        decisionKind: "work_question";
        timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
        requestId: string;
        nonce: string;
        requestDigest: string;
        sourceRevision: number;
        idempotencyKey: string;
        outcome: "cancelled" | "expired" | "answered";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        decidedAt: string;
        answer?: unknown;
    };
}>, z.ZodObject<{
    commandKind: z.ZodLiteral<"checkpoint">;
    deadline: z.ZodString;
    organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
    companyId: z.ZodBranded<z.ZodString, "CompanyId">;
    workerId: z.ZodBranded<z.ZodString, "WorkerId">;
    jobId: z.ZodBranded<z.ZodString, "JobId">;
    attempt: z.ZodNumber;
    leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
    fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
    protocolVersion: z.ZodLiteral<1>;
    audience: z.ZodLiteral<"control_channel">;
    commandId: z.ZodString;
    commandSeq: z.ZodNumber;
    idempotencyKey: z.ZodString;
    issuedAt: z.ZodString;
    nonce: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    deadline: string;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    issuedAt: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "checkpoint";
    commandId: string;
    commandSeq: number;
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    deadline: string;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    issuedAt: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "checkpoint";
    commandId: string;
    commandSeq: number;
}>, z.ZodObject<{
    commandKind: z.ZodLiteral<"graceful_stop">;
    deadline: z.ZodString;
    organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
    companyId: z.ZodBranded<z.ZodString, "CompanyId">;
    workerId: z.ZodBranded<z.ZodString, "WorkerId">;
    jobId: z.ZodBranded<z.ZodString, "JobId">;
    attempt: z.ZodNumber;
    leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
    fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
    protocolVersion: z.ZodLiteral<1>;
    audience: z.ZodLiteral<"control_channel">;
    commandId: z.ZodString;
    commandSeq: z.ZodNumber;
    idempotencyKey: z.ZodString;
    issuedAt: z.ZodString;
    nonce: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    deadline: string;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    issuedAt: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "graceful_stop";
    commandId: string;
    commandSeq: number;
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    deadline: string;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    issuedAt: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "graceful_stop";
    commandId: string;
    commandSeq: number;
}>, z.ZodObject<{
    commandKind: z.ZodLiteral<"drain">;
    reason: z.ZodNullable<z.ZodString>;
    organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
    companyId: z.ZodBranded<z.ZodString, "CompanyId">;
    workerId: z.ZodBranded<z.ZodString, "WorkerId">;
    jobId: z.ZodBranded<z.ZodString, "JobId">;
    attempt: z.ZodNumber;
    leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
    fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
    protocolVersion: z.ZodLiteral<1>;
    audience: z.ZodLiteral<"control_channel">;
    commandId: z.ZodString;
    commandSeq: z.ZodNumber;
    idempotencyKey: z.ZodString;
    issuedAt: z.ZodString;
    nonce: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    issuedAt: string;
    reason: string | null;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "drain";
    commandId: string;
    commandSeq: number;
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    issuedAt: string;
    reason: string | null;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "drain";
    commandId: string;
    commandSeq: number;
}>]>, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    issuedAt: string;
    reason: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "cancel";
    graceful: boolean;
    commandId: string;
    commandSeq: number;
} | {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    issuedAt: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "product_approval_result";
    commandId: string;
    commandSeq: number;
    result: {
        approvalId: string;
        idempotencyKey: string;
        approvalKind: string;
        approvalVersion: number;
        decision: "expired" | "rejected" | "approved";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        decidedAt: string;
        governedActionRef: {
            kind: string;
            id: string;
        };
    };
} | {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    issuedAt: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "runtime_decision_result";
    commandId: string;
    commandSeq: number;
    result: {
        schemaVersion: number;
        expiresAt: string;
        decisionKind: "permission";
        timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
        requestId: string;
        nonce: string;
        requestDigest: string & z.BRAND<"Sha256Digest">;
        sourceRevision: number;
        idempotencyKey: string;
        decision: "deny" | "allow_once" | "allow_run" | "cancelled" | "expired" | "allow_always";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        decidedAt: string;
    } | {
        schemaVersion: number;
        expiresAt: string;
        decisionKind: "work_question";
        timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
        requestId: string;
        nonce: string;
        requestDigest: string & z.BRAND<"Sha256Digest">;
        sourceRevision: number;
        idempotencyKey: string;
        outcome: "cancelled" | "expired" | "answered";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string & z.BRAND<"PrincipalId">;
        };
        decidedAt: string;
        answer?: unknown;
    };
} | {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    deadline: string;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    issuedAt: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "checkpoint";
    commandId: string;
    commandSeq: number;
} | {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    deadline: string;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    issuedAt: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "graceful_stop";
    commandId: string;
    commandSeq: number;
} | {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    issuedAt: string;
    reason: string | null;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "drain";
    commandId: string;
    commandSeq: number;
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    issuedAt: string;
    reason: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "cancel";
    graceful: boolean;
    commandId: string;
    commandSeq: number;
} | {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    issuedAt: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "product_approval_result";
    commandId: string;
    commandSeq: number;
    result: {
        approvalId: string;
        idempotencyKey: string;
        approvalKind: string;
        approvalVersion: number;
        decision: "expired" | "rejected" | "approved";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        decidedAt: string;
        governedActionRef: {
            kind: string;
            id: string;
        };
    };
} | {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    issuedAt: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "runtime_decision_result";
    commandId: string;
    commandSeq: number;
    result: {
        schemaVersion: number;
        expiresAt: string;
        decisionKind: "permission";
        timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate";
        requestId: string;
        nonce: string;
        requestDigest: string;
        sourceRevision: number;
        idempotencyKey: string;
        decision: "deny" | "allow_once" | "allow_run" | "cancelled" | "expired" | "allow_always";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        decidedAt: string;
    } | {
        schemaVersion: number;
        expiresAt: string;
        decisionKind: "work_question";
        timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate";
        requestId: string;
        nonce: string;
        requestDigest: string;
        sourceRevision: number;
        idempotencyKey: string;
        outcome: "cancelled" | "expired" | "answered";
        decidedBy: {
            principalType: "user" | "agent" | "service" | "system";
            principalId: string;
        };
        decidedAt: string;
        answer?: unknown;
    };
} | {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    deadline: string;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    issuedAt: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "checkpoint";
    commandId: string;
    commandSeq: number;
} | {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    deadline: string;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    issuedAt: string;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "graceful_stop";
    commandId: string;
    commandSeq: number;
} | {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    issuedAt: string;
    reason: string | null;
    nonce: string;
    audience: "control_channel";
    idempotencyKey: string;
    commandKind: "drain";
    commandId: string;
    commandSeq: number;
}>;
export type ControlCommandV1 = z.infer<typeof controlCommandV1Schema>;
export declare const CONTROL_ACK_STATUSES: readonly ["accepted", "completed", "rejected", "stale"];
export declare const controlCommandAckStatusSchema: z.ZodEnum<["accepted", "completed", "rejected", "stale"]>;
export type ControlCommandAckStatus = (typeof CONTROL_ACK_STATUSES)[number];
/** The worker's ACK for a control command: it echoes the command ID + sequence
 * and reports a closed status. An unknown status fails closed. */
export declare const controlCommandAckV1Schema: z.ZodEffects<z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    correlationId: z.ZodString;
    commandId: z.ZodString;
    commandSeq: z.ZodNumber;
    status: z.ZodEnum<["accepted", "completed", "rejected", "stale"]>;
    observedAt: z.ZodString;
    detail: z.ZodNullable<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    status: "accepted" | "rejected" | "completed" | "stale";
    protocolVersion: 1;
    observedAt: string;
    detail: string | null;
    correlationId: string;
    commandId: string;
    commandSeq: number;
}, {
    status: "accepted" | "rejected" | "completed" | "stale";
    protocolVersion: 1;
    observedAt: string;
    detail: string | null;
    correlationId: string;
    commandId: string;
    commandSeq: number;
}>, {
    status: "accepted" | "rejected" | "completed" | "stale";
    protocolVersion: 1;
    observedAt: string;
    detail: string | null;
    correlationId: string;
    commandId: string;
    commandSeq: number;
}, {
    status: "accepted" | "rejected" | "completed" | "stale";
    protocolVersion: 1;
    observedAt: string;
    detail: string | null;
    correlationId: string;
    commandId: string;
    commandSeq: number;
}>;
export type ControlCommandAckV1 = z.infer<typeof controlCommandAckV1Schema>;
export declare const CONTROL_RECEIVER_DECISIONS: readonly ["accept", "replay", "gap", "conflict", "stale"];
export declare const controlReceiverDecisionSchema: z.ZodEnum<["accept", "replay", "gap", "conflict", "stale"]>;
export type ControlReceiverDecisionV1 = (typeof CONTROL_RECEIVER_DECISIONS)[number];
/** The prior accepted state a control receiver decides against. `acceptedThroughSeq`
 * is the highest contiguous command sequence accepted (0 = none); `activeFenceToken`
 * is the current authoritative fence; `priorForCommandId` is the recorded record
 * for THIS command's ID (null = never seen). */
export interface ControlReceiverStateV1 {
    readonly acceptedThroughSeq: number;
    readonly activeFenceToken: string;
    readonly priorForCommandId: {
        readonly seq: number;
        readonly bodyDigest: string;
    } | null;
}
export interface ControlReceiverCommandV1 {
    readonly commandId: string;
    readonly commandSeq: number;
    readonly fenceToken: string;
    readonly bodyDigest: string;
}
/**
 * Classify a control command against prior accepted state. Idempotency wins first
 * (same ID → replay on an identical body, conflict on a changed body); a command
 * bound to a superseded fence is stale; an already-accepted sequence replays; a
 * skipped sequence is a gap; the next contiguous sequence is accepted.
 */
export declare function decideControlReceiverV1(state: ControlReceiverStateV1, command: ControlReceiverCommandV1): ControlReceiverDecisionV1;
export declare const EVENT_RECEIVER_DECISIONS: readonly ["accept", "replay", "gap", "hash_mismatch", "stale_fence", "terminal"];
export declare const eventReceiverDecisionSchema: z.ZodEnum<["accept", "replay", "gap", "hash_mismatch", "stale_fence", "terminal"]>;
export type EventReceiverDecisionV1 = (typeof EVENT_RECEIVER_DECISIONS)[number];
/** The prior accepted state an event receiver decides against. `priorDigestForEventId`
 * is the recomputed digest stored for THIS event's ID (null = never seen). */
export interface EventReceiverStateV1 {
    readonly acceptedThroughSeq: number;
    readonly activeFenceToken: string;
    readonly terminalReached: boolean;
    readonly priorDigestForEventId: string | null;
}
export interface EventReceiverInputV1 {
    readonly eventId: string;
    readonly seq: number;
    readonly fenceToken: string;
    readonly suppliedDigest: string;
    readonly recomputedDigest: string;
}
/**
 * Classify a worker event against prior accepted state. The receiver recomputes
 * the digest FIRST: a supplied digest that disagrees with the recomputation is
 * `hash_mismatch` before any persistence/idempotency handling. Then a superseded
 * fence is `stale_fence`; a terminal attempt is `terminal`; a previously seen ID
 * replays on an identical digest and is `hash_mismatch` on a changed digest; an
 * already-accepted sequence replays; a skipped sequence is a gap; the next
 * contiguous sequence is accepted.
 */
export declare function decideEventReceiverV1(state: EventReceiverStateV1, input: EventReceiverInputV1): EventReceiverDecisionV1;
/** The ten framework-neutral worker-protocol operations. */
export declare const WORKER_PROTOCOL_OPERATIONS: readonly ["enrollment", "poll", "lease_ack", "lease_renew", "event_upload", "artifact_transfer_grant", "artifact_commit", "quarantine_grant", "quarantine_finalize", "control_command"];
export type WorkerProtocolOperation = (typeof WORKER_PROTOCOL_OPERATIONS)[number];
/** The retry rule for an operation: a safe read may be freely re-issued; an
 * idempotency-keyed mutation may be retried with the same key; a non-retryable
 * operation must not be blindly retried. */
export type OperationRetryRule = "safe_read" | "idempotent_retry" | "no_retry";
export interface OperationDescriptorV1 {
    readonly operation: WorkerProtocolOperation;
    readonly audience: AuthAudience;
    readonly idempotent: boolean;
    readonly retry: OperationRetryRule;
    readonly maxRequestBytes: number;
    readonly timeoutMs: number;
    readonly successOutcomes: readonly string[];
    readonly errors: readonly ProtocolErrorCode[];
}
/** Every operation's contract facts (audience, correlation/idempotency, retry
 * rule, payload ceiling, client timeout, success outcomes, stable errors). The
 * operation document (`operations.md`) mirrors exactly this set, and the contract
 * test proves each exported operation has a row and vice versa. */
export declare const OPERATION_DESCRIPTORS: Readonly<Record<WorkerProtocolOperation, OperationDescriptorV1>>;
