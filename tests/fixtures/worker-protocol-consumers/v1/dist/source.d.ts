import { z } from "zod";
/** Coarse wire principal types. Domain roles (founder/team_lead/worker/…) are a
 * separate authority checked by JOB-001/JOB-010, not by this schema. */
export declare const PRINCIPAL_TYPES: readonly ["user", "agent", "service", "system"];
export declare const principalTypeSchema: z.ZodEnum<["user", "agent", "service", "system"]>;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];
/** A typed requester/executor principal: a coarse type plus an opaque,
 * byte-preserving principal ID. */
export declare const principalV1Schema: z.ZodObject<{
    principalType: z.ZodEnum<["user", "agent", "service", "system"]>;
    principalId: z.ZodBranded<z.ZodEffects<z.ZodString, string, string>, "PrincipalId">;
}, "strict", z.ZodTypeAny, {
    principalType: "user" | "agent" | "service" | "system";
    principalId: string & z.BRAND<"PrincipalId">;
}, {
    principalType: "user" | "agent" | "service" | "system";
    principalId: string;
}>;
export type PrincipalV1 = z.infer<typeof principalV1Schema>;
/** The exact set of one-shot operation kinds. */
export declare const ONE_SHOT_OPERATION_KINDS: readonly ["extraction", "compaction", "readiness_probe"];
export declare const oneShotOperationKindSchema: z.ZodEnum<["extraction", "compaction", "readiness_probe"]>;
export type OneShotOperationKind = (typeof ONE_SHOT_OPERATION_KINDS)[number];
/** The exact set of execution-source discriminants. */
export declare const EXECUTION_SOURCE_KINDS: readonly ["task_run", "commander_turn", "crew_run", "one_shot", "browser_request", "service_reconcile"];
export type ExecutionSourceKind = (typeof EXECUTION_SOURCE_KINDS)[number];
export declare const taskRunSourceSchema: z.ZodObject<{
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
}>;
export type TaskRunSource = z.infer<typeof taskRunSourceSchema>;
export declare const commanderTurnSourceSchema: z.ZodObject<{
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
}>;
export type CommanderTurnSource = z.infer<typeof commanderTurnSourceSchema>;
export declare const crewRunSourceSchema: z.ZodObject<{
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
}>;
export type CrewRunSource = z.infer<typeof crewRunSourceSchema>;
export declare const oneShotSourceSchema: z.ZodObject<{
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
}>;
export type OneShotSource = z.infer<typeof oneShotSourceSchema>;
export declare const browserRequestSourceSchema: z.ZodObject<{
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
}>;
export type BrowserRequestSource = z.infer<typeof browserRequestSourceSchema>;
export declare const serviceReconcileSourceSchema: z.ZodObject<{
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
}>;
export type ServiceReconcileSource = z.infer<typeof serviceReconcileSourceSchema>;
/**
 * The strict execution-source union. Unknown source kinds fail closed. For
 * `task_run`, the execution principal must be an `agent` whose opaque principal
 * ID is byte-for-byte equal to the UUID-branded `assigneeAgentId` — a stale or
 * mismatched executor is denied at the schema boundary; JOB-001/JOB-010 still
 * own the authenticated/domain authorization of the requester.
 */
export declare const executionSourceV1Schema: z.ZodEffects<z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
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
export type ExecutionSourceV1 = z.infer<typeof executionSourceV1Schema>;
