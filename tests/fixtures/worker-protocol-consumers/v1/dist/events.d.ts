import { z } from "zod";
export declare const attemptStartedPayloadV1Schema: z.ZodObject<{
    sandboxId: z.ZodBranded<z.ZodString, "SandboxId">;
}, "strict", z.ZodTypeAny, {
    sandboxId: string & z.BRAND<"SandboxId">;
}, {
    sandboxId: string;
}>;
export type AttemptStartedPayloadV1 = z.infer<typeof attemptStartedPayloadV1Schema>;
export declare const LOG_STREAMS: readonly ["stdout", "stderr", "system"];
export declare const LOG_LEVELS: readonly ["debug", "info", "warn", "error"];
export declare const logPayloadV1Schema: z.ZodObject<{
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
export type LogPayloadV1 = z.infer<typeof logPayloadV1Schema>;
export declare const progressPayloadV1Schema: z.ZodObject<{
    message: z.ZodString;
    percent: z.ZodNullable<z.ZodNumber>;
}, "strict", z.ZodTypeAny, {
    message: string;
    percent: number | null;
}, {
    message: string;
    percent: number | null;
}>;
export type ProgressPayloadV1 = z.infer<typeof progressPayloadV1Schema>;
export declare const usagePayloadV1Schema: z.ZodObject<{
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
export type UsagePayloadV1 = z.infer<typeof usagePayloadV1Schema>;
export declare const artifactPreparedPayloadV1Schema: z.ZodObject<{
    artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
    kind: z.ZodString;
}, "strict", z.ZodTypeAny, {
    kind: string;
    artifactId: string & z.BRAND<"ArtifactId">;
}, {
    kind: string;
    artifactId: string;
}>;
export type ArtifactPreparedPayloadV1 = z.infer<typeof artifactPreparedPayloadV1Schema>;
export declare const browserObservationPayloadV1Schema: z.ZodObject<{
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
export type BrowserObservationPayloadV1 = z.infer<typeof browserObservationPayloadV1Schema>;
export declare const browserApprovalRequestedPayloadV1Schema: z.ZodObject<{
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
export type BrowserApprovalRequestedPayloadV1 = z.infer<typeof browserApprovalRequestedPayloadV1Schema>;
export declare const PERMISSION_TIMEOUT_POLICIES: readonly ["deny", "cancel_run", "park_run", "continue_with_default", "escalate"];
export declare const permissionTimeoutPolicySchema: z.ZodEnum<["deny", "cancel_run", "park_run", "continue_with_default", "escalate"]>;
export type PermissionTimeoutPolicy = (typeof PERMISSION_TIMEOUT_POLICIES)[number];
export declare const PERMISSION_DEFAULT_DECISIONS: readonly ["allow_once", "allow_run", "deny"];
export declare const permissionDefaultDecisionSchema: z.ZodEnum<["allow_once", "allow_run", "deny"]>;
export type PermissionDefaultDecision = (typeof PERMISSION_DEFAULT_DECISIONS)[number];
export declare const permissionRuntimeDecisionRequestV1Schema: z.ZodObject<{
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
}>;
export type PermissionRuntimeDecisionRequestV1 = z.infer<typeof permissionRuntimeDecisionRequestV1Schema>;
export declare const WORK_QUESTION_TIMEOUT_POLICIES: readonly ["cancel_run", "park_run", "continue_with_default", "escalate"];
export declare const workQuestionTimeoutPolicySchema: z.ZodEnum<["cancel_run", "park_run", "continue_with_default", "escalate"]>;
export type WorkQuestionTimeoutPolicy = (typeof WORK_QUESTION_TIMEOUT_POLICIES)[number];
export declare const workQuestionOptionV1Schema: z.ZodObject<{
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
}>;
export type WorkQuestionOptionV1 = z.infer<typeof workQuestionOptionV1Schema>;
export declare const workQuestionRuntimeDecisionRequestV1Schema: z.ZodObject<{
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
}>;
export type WorkQuestionRuntimeDecisionRequestV1 = z.infer<typeof workQuestionRuntimeDecisionRequestV1Schema>;
/**
 * The request side of PRT-007's durable runtime decision. `continue_with_default`
 * fail-closed rules: permission requires a non-null `defaultDecision` (every other
 * policy requires null); a work question requires exactly one `isDefault` option
 * (every other policy requires zero). Cross-kind fields are rejected by `.strict()`.
 */
export declare const runtimeDecisionRequestV1Schema: z.ZodEffects<z.ZodDiscriminatedUnion<"decisionKind", [z.ZodObject<{
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
export type RuntimeDecisionRequestV1 = z.infer<typeof runtimeDecisionRequestV1Schema>;
export declare const serviceInstanceStartedPayloadV1Schema: z.ZodObject<{
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
export type ServiceInstanceStartedPayloadV1 = z.infer<typeof serviceInstanceStartedPayloadV1Schema>;
export declare const SERVICE_HEALTH_STATUSES: readonly ["healthy", "unhealthy"];
export declare const serviceHealthPayloadV1Schema: z.ZodObject<{
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
export type ServiceHealthPayloadV1 = z.infer<typeof serviceHealthPayloadV1Schema>;
export declare const serviceCheckpointPreparedPayloadV1Schema: z.ZodObject<{
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
export type ServiceCheckpointPreparedPayloadV1 = z.infer<typeof serviceCheckpointPreparedPayloadV1Schema>;
export declare const serviceCheckpointRestoredPayloadV1Schema: z.ZodObject<{
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
export type ServiceCheckpointRestoredPayloadV1 = z.infer<typeof serviceCheckpointRestoredPayloadV1Schema>;
export declare const serviceGracefulStopObservedPayloadV1Schema: z.ZodObject<{
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
export type ServiceGracefulStopObservedPayloadV1 = z.infer<typeof serviceGracefulStopObservedPayloadV1Schema>;
export declare const serviceInstanceStoppedPayloadV1Schema: z.ZodObject<{
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
export type ServiceInstanceStoppedPayloadV1 = z.infer<typeof serviceInstanceStoppedPayloadV1Schema>;
export declare const serviceInstanceLostPayloadV1Schema: z.ZodObject<{
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
export type ServiceInstanceLostPayloadV1 = z.infer<typeof serviceInstanceLostPayloadV1Schema>;
export declare const serviceProviderInterruptedPayloadV1Schema: z.ZodObject<{
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
export type ServiceProviderInterruptedPayloadV1 = z.infer<typeof serviceProviderInterruptedPayloadV1Schema>;
export declare const serviceProviderResumedPayloadV1Schema: z.ZodObject<{
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
export type ServiceProviderResumedPayloadV1 = z.infer<typeof serviceProviderResumedPayloadV1Schema>;
export declare const NETWORK_DENIAL_CLASSES: readonly ["metadata", "private", "control_plane", "not_allowlisted"];
export declare const networkDeniedPayloadV1Schema: z.ZodObject<{
    destinationClass: z.ZodEnum<["metadata", "private", "control_plane", "not_allowlisted"]>;
    reason: z.ZodString;
}, "strict", z.ZodTypeAny, {
    reason: string;
    destinationClass: "metadata" | "private" | "control_plane" | "not_allowlisted";
}, {
    reason: string;
    destinationClass: "metadata" | "private" | "control_plane" | "not_allowlisted";
}>;
export type NetworkDeniedPayloadV1 = z.infer<typeof networkDeniedPayloadV1Schema>;
export declare const TERMINAL_EVENT_STATUSES: readonly ["succeeded", "failed", "cancelled", "expired"];
export declare const terminalEventStatusSchema: z.ZodEnum<["succeeded", "failed", "cancelled", "expired"]>;
export type TerminalEventStatus = (typeof TERMINAL_EVENT_STATUSES)[number];
export declare const terminalEventPayloadV1Schema: z.ZodObject<{
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
export type TerminalEventPayloadV1 = z.infer<typeof terminalEventPayloadV1Schema>;
export declare const WORKER_EVENT_TYPES: readonly ["attempt_started", "log", "progress", "usage", "artifact_prepared", "browser_observation", "browser_approval_requested", "runtime_decision_requested", "service_instance_started", "service_health", "service_checkpoint_prepared", "service_checkpoint_restored", "service_graceful_stop_observed", "service_instance_stopped", "service_instance_lost", "service_provider_interrupted", "service_provider_resumed", "network_denied", "terminal"];
export declare const workerEventTypeSchema: z.ZodEnum<["attempt_started", "log", "progress", "usage", "artifact_prepared", "browser_observation", "browser_approval_requested", "runtime_decision_requested", "service_instance_started", "service_health", "service_checkpoint_prepared", "service_checkpoint_restored", "service_graceful_stop_observed", "service_instance_stopped", "service_instance_lost", "service_provider_interrupted", "service_provider_resumed", "network_denied", "terminal"]>;
export type WorkerEventType = (typeof WORKER_EVENT_TYPES)[number];
/** The strict V1 worker-event union, discriminated by `eventType`, with a
 * recursive forbidden-credential-key scan and the ONE shared bounded-extension
 * container (`addWireExtensionArrayIssues`) applied to every event — identical to
 * job/lease enforcement (E1-F005). */
export declare const workerEventV1Schema: z.ZodEffects<z.ZodDiscriminatedUnion<"eventType", [z.ZodObject<{
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
}>;
export type WorkerEventV1 = z.infer<typeof workerEventV1Schema>;
/**
 * A submitted batch of 1–500 events. Every event must repeat the batch
 * organization/company/worker/job/attempt/lease/fence, event IDs are unique, and
 * sequences are contiguous (each `seq` exactly one greater than the previous).
 */
export declare const workerEventBatchV1Schema: z.ZodEffects<z.ZodObject<{
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
export type WorkerEventBatchV1 = z.infer<typeof workerEventBatchV1Schema>;
export declare const WORKER_EVENT_ACK_STATUSES: readonly ["accepted", "gap", "hash_mismatch", "stale_fence", "target_revoked", "terminal"];
export declare const workerEventAckStatusSchema: z.ZodEnum<["accepted", "gap", "hash_mismatch", "stale_fence", "target_revoked", "terminal"]>;
export type WorkerEventAckStatus = (typeof WORKER_EVENT_ACK_STATUSES)[number];
/**
 * A cumulative ACK. `expectedNextSeq === acceptedThroughSeq + 1`. A
 * `hash_mismatch` names the conflicting `rejectedEventId`; every non-conflict
 * status forbids it. Negative sequences are rejected.
 */
export declare const workerEventAckV1Schema: z.ZodEffects<z.ZodObject<{
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
export type WorkerEventAckV1 = z.infer<typeof workerEventAckV1Schema>;
